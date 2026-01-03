const { spawn } = require('child_process');
const { TUNERS } = require('./tuner');
const Channels = require('./channels');
const { db } = require('./db');
const { CHANNELS_CONF, VERBOSE_LOGGING } = require('./config');
const { debugLog, delay } = require('./utils');

const EPG = {
    lastScan: 0,
    isScanning: false,
    isInitialScanDone: false,
    sourceMap: new Map(), // ATSC Mapping: "freq_sourceId" -> channelNumber (e.g., "500000000_1" -> "15.1")
    sectionBuffers: new Map(),

    // Helper: Parse DVB BCD and MJD to Timestamp
    parseDVBTime(mjd, bcd) {
        const Y = Math.floor((mjd - 15078.2) / 365.25);
        const M = Math.floor((mjd - 14956.1 - Math.floor(Y * 365.25)) / 30.6001);
        const D = mjd - 14956 - Math.floor(Y * 365.25) - Math.floor(M * 30.6001);
        const k = (M === 14 || M === 15) ? 1 : 0;
        const year = 1900 + Y + k;
        const month = M - 1 - k * 12;

        const h = ((bcd >> 20) & 0x0F) * 10 + ((bcd >> 16) & 0x0F);
        const m = ((bcd >> 12) & 0x0F) * 10 + ((bcd >> 8) & 0x0F);
        const s = ((bcd >> 4) & 0x0F) * 10 + (bcd & 0x0F);

        try {
            return new Date(Date.UTC(year, month - 1, D, h, m, s)).getTime();
        } catch (e) { return 0; }
    },

    async grab(scanTimeout = 15000) {
        if (this.isScanning) return;

        // Check if all tuners are free
        const freeTuners = TUNERS.filter(t => !t.inUse);
        if (freeTuners.length < TUNERS.length) {
            console.log('[EPG] Tuners busy, skipping scan.');
            this.isInitialScanDone = true; // Allow streaming if scan can't start
            return;
        }

        this.isScanning = true;
        try {
            console.log('[EPG] Starting background EPG scan...');

            const muxMap = new Map();
            Channels.CHANNELS.forEach(c => {
                if (c.frequency) {
                    if (!muxMap.has(c.frequency)) muxMap.set(c.frequency, c.number);
                }
            });

            const frequencies = Array.from(muxMap.keys());

            for (const freq of frequencies) {
                // Re-check tuner status before each mux
                const tuner = TUNERS.find(t => !t.inUse);
                if (!tuner) break;

                tuner.inUse = true;
                tuner.epgScanning = true;
                const channelName = muxMap.get(freq);

                console.log(`[EPG] Scanning mux at ${freq} Hz using ${channelName} on Tuner ${tuner.id}...`);

                try {
                    await this.scanMux(tuner, channelName, freq, scanTimeout);
                } catch (e) {
                    console.error(`[EPG] Error scanning mux at ${freq}:`, e);
                }

                tuner.inUse = false;
                tuner.epgScanning = false;

                // Short delay between muxes
                await delay(2000);
            }
        } catch (e) {
            console.error('[EPG] Critical error during grab:', e);
        } finally {
            this.isScanning = false;
            this.lastScan = Date.now();
            this.isInitialScanDone = true;
            console.log('[EPG] Background EPG scan complete.');
        }
    },

    scanMux(tuner, channelName, freq, scanTimeout) {
        return new Promise((resolve) => {
            const args = [
                '-c', CHANNELS_CONF,
                '-a', tuner.id,
                '-P', // User requested standalone flag
                '-t', Math.ceil(scanTimeout / 1000).toString(),
                '-o', '-',
                channelName
            ];

            debugLog(`[EPG Debug] Spawning zap with args: ${JSON.stringify(args)}`);

            const zap = spawn('dvbv5-zap', args);

            let buffer = Buffer.alloc(0);
            let dataReceived = false;

            zap.stdout.on('data', (data) => {
                if (!dataReceived) {
                    console.log(`[EPG] Receiving data stream for ${channelName}...`);
                    dataReceived = true;
                }
                buffer = Buffer.concat([buffer, data]);
                if (buffer.length > 50 * 1024 * 1024) { // 50MB limit for full mux scan
                    zap.kill('SIGKILL');
                }
            });

            zap.stderr.on('data', (d) => {
                debugLog(`[EPG Debug] Zap stderr: ${d.toString()}`);
            });

            const timeout = setTimeout(() => {
                if (!dataReceived) console.warn(`[EPG] No data received for ${channelName} after ${scanTimeout / 1000}s. Signal might be weak.`);
                zap.kill('SIGKILL');
            }, scanTimeout); // User specified timeout

            zap.on('exit', () => {
                clearTimeout(timeout);

                const count = this.parseEIT(buffer, freq);
                console.log(`[EPG] Mux scan finished. Discovered ${count} program entries.`);
                resolve();
            });
        });
    },

    parseEIT(buffer, freq) {
        const stats = { count: 0 };
        const sections = new Map();

        debugLog(`[EPG] Beginning parse of ${buffer.length} bytes for frequency ${freq}...`);
        const pidCounts = new Map();
        const tableCounts = new Map();

        if (!this.sectionBuffers) this.sectionBuffers = new Map();

        for (let i = 0; i < buffer.length - 188; i += 188) {
            if (buffer[i] !== 0x47) continue; // Sync check
            const pid = ((buffer[i + 1] & 0x1F) << 8) | buffer[i + 2];
            pidCounts.set(pid, (pidCounts.get(pid) || 0) + 1);

            const pusi = buffer[i + 1] & 0x40;
            const adaptation = (buffer[i + 3] & 0x30) >> 4;
            let payloadOffset = 4;
            if (adaptation === 2 || adaptation === 3) payloadOffset += buffer[i + 4] + 1;

            if (payloadOffset >= 188) continue;
            let payload = buffer.slice(i + payloadOffset, i + 188);

            if (pusi) {
                const pointer = payload[0];
                const sectionStart = payload.slice(pointer + 1);
                if (sectionStart.length >= 3) {
                    const sectionLen = ((sectionStart[1] & 0x0F) << 8) | sectionStart[2];
                    const totalLen = sectionLen + 3;
                    if (sectionStart.length >= totalLen) {
                        this.handleCompleteSection(sectionStart.slice(0, totalLen), pid, stats, tableCounts, sections, freq);
                    } else {
                        this.sectionBuffers.set(pid, { buffer: sectionStart, totalLength: totalLen });
                    }
                }
            } else {
                const state = this.sectionBuffers.get(pid);
                if (state) {
                    state.buffer = Buffer.concat([state.buffer, payload]);
                    if (state.buffer.length >= state.totalLength) {
                        this.handleCompleteSection(state.buffer.slice(0, state.totalLength), pid, stats, tableCounts, sections, freq);
                        this.sectionBuffers.delete(pid);
                    }
                }
            }
        }

        const sortedPids = Array.from(pidCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10);
        debugLog('[EPG] Top 10 PIDs found:', Object.fromEntries(sortedPids));
        debugLog(`[EPG] Guide PIDs seen? DVB(18): ${pidCounts.get(18) || 0}, ATSC(8187): ${pidCounts.get(8187) || 0}`);

        const tableSummary = {};
        tableCounts.forEach((v, k) => tableSummary[`0x${k.toString(16).toUpperCase()}`] = v);
        debugLog('[EPG] ATSC Tables found:', tableSummary);

        return stats.count;
    },

    handleCompleteSection(section, pid, stats, tableCounts, sections, freq) {
        const tableId = section[0];
        if (tableId >= 0xC7 && tableId <= 0xCF) {
            tableCounts.set(tableId, (tableCounts.get(tableId) || 0) + 1);
        }

        if (tableId === 0xC8 || tableId === 0xC9) {
            this.parseATSCVCT(section, freq);
        } else if ((tableId >= 0x4E && tableId <= 0x6F) || (tableId >= 0xC7 && tableId <= 0xCF)) {
            const id = (section[3] << 8) | section[4];
            this.parseEITSection(section, id, () => { stats.count++; }, freq);
        }
    },

    parseEITSection(section, id, onFound, freq) {
        const tableId = section[0];
        const sectionLength = ((section[1] & 0x0F) << 8) | section[2];
        if (section.length < sectionLength + 3) return;

        const mapKey = `${freq}_${id}`;

        if (tableId === 0xCB) {
            // EIT (Event Information Table)
            let serviceId = this.sourceMap.get(mapKey) || id.toString();
            this.parseATSCEIT(section, serviceId, onFound, id, freq);
        } else if (tableId === 0xCC) {
            // ETT (Extended Text Table)
            let serviceId = this.sourceMap.get(mapKey) || id.toString();
            this.parseATSCEET(section, id, serviceId, freq);
        } else if (tableId >= 0x4E && tableId <= 0x6F) {
            this.parseDVBEIT(section, id, onFound, freq);
        }
    },

    parseATSCVCT(section, freq) {
        try {
            const sectionLength = ((section[1] & 0x0F) << 8) | section[2];
            const numChannels = section[9];
            let offset = 10;

            for (let i = 0; i < numChannels; i++) {
                if (offset + 32 > sectionLength + 3) break;

                const programNumber = (section[offset + 24] << 8) | section[offset + 25];
                const sourceId = (section[offset + 28] << 8) | section[offset + 29];

                if (sourceId) {
                    const mapKey = `${freq}_${sourceId}`;
                    const major = ((section[offset + 14] & 0x0F) << 6) | (section[offset + 15] >> 2);
                    const minor = ((section[offset + 15] & 0x03) << 8) | section[offset + 16];
                    const virtualChannel = `${major}.${minor}`;

                    let channel = Channels.CHANNELS.find(c => c.frequency == freq && c.number === virtualChannel);
                    if (!channel) {
                        channel = Channels.CHANNELS.find(c => c.frequency == freq && c.serviceId == programNumber.toString());
                    }
                    if (!channel) {
                        channel = Channels.CHANNELS.find(c => c.number === virtualChannel);
                    }

                    if (channel) {
                        if (this.sourceMap.get(mapKey) !== channel.number) {
                            debugLog(`[ATSC VCT] Map: ${freq} Source ${sourceId} -> ${channel.name} (${channel.number})`);
                            this.sourceMap.set(mapKey, channel.number);
                        }
                    } else {
                        if (!this.sourceMap.has(mapKey)) {
                            debugLog(`[ATSC VCT] Unconfigured: ${freq} Source ${sourceId} -> ${virtualChannel}`);
                            this.sourceMap.set(mapKey, virtualChannel);
                        }
                    }
                }
                const descriptorsLength = ((section[offset + 30] & 0x03) << 8) | section[offset + 31];
                offset += 32 + descriptorsLength;
            }
        } catch (e) {
            console.error('[ATSC VCT] Error:', e);
        }
    },

    parseATSCEIT(section, virtualChannel, onFound, sourceId, freq) {
        try {
            const sectionLength = ((section[1] & 0x0F) << 8) | section[2];
            const numEvents = section[9];
            let offset = 10;

            for (let i = 0; i < numEvents; i++) {
                if (offset + 10 > sectionLength + 3) break;

                const eventId = ((section[offset] & 0x3F) << 8) | section[offset + 1];
                const startTimeGPS = section.readUInt32BE(offset + 2);
                const duration = ((section[offset + 6] & 0x0F) << 16) | (section[offset + 7] << 8) | section[offset + 8];
                const titleLength = section[offset + 9];

                const startTime = (startTimeGPS + 315964800 - 18) * 1000;
                const endTime = startTime + duration * 1000;

                let title = '';
                let description = '';
                let currentEventOffset = offset + 10;

                if (titleLength > 0 && currentEventOffset + titleLength <= section.length) {
                    let titleBuffer = section.slice(currentEventOffset, currentEventOffset + titleLength);
                    if (titleBuffer.length > 0) {
                        const numStrings = titleBuffer[0];
                        let stringOffset = 1;
                        if (numStrings > 0 && titleBuffer.length >= stringOffset + 7) {
                            const stringLen = titleBuffer[stringOffset + 6];
                            if (titleBuffer.length >= stringOffset + 7 + stringLen) {
                                title = titleBuffer.slice(stringOffset + 7, stringOffset + 7 + stringLen).toString('utf8');
                                title = title.replace(/[\x00-\x09\x0B-\x1F\x7F]+/g, '').trim();
                            }
                        }
                    }
                }

                currentEventOffset += titleLength;

                if (currentEventOffset + 2 <= section.length - 4) {
                    const descriptorsLength = ((section[currentEventOffset] & 0x0F) << 8) | section[currentEventOffset + 1];
                    currentEventOffset += 2 + descriptorsLength;
                }

                if (title && startTime > 0) {
                    onFound();
                    db.run(`INSERT INTO programs (frequency, channel_service_id, start_time, end_time, title, description, event_id, source_id) 
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                            ON CONFLICT(frequency, channel_service_id, start_time) 
                            DO UPDATE SET title=excluded.title, end_time=excluded.end_time, event_id=excluded.event_id, source_id=excluded.source_id`,
                        [freq, virtualChannel, startTime, endTime, title, description, eventId, sourceId]);
                }

                offset = currentEventOffset;
            }
        } catch (e) {
            console.error('[ATSC DEBUG] Error parsing EIT:', e);
        }
    },

    parseATSCEET(section, sourceId, virtualChannel, freq) {
        try {
            const sectionLength = ((section[1] & 0x0F) << 8) | section[2];
            if (section.length < 13) return;

            const etmId = section.readUInt32BE(9);
            const eventId = (etmId >> 2) & 0x3FFF;

            let desc = '';
            const mssBuffer = section.slice(13, sectionLength + 3 - 4);
            if (mssBuffer.length > 5) {
                const numStrings = mssBuffer[0];
                if (numStrings > 0) {
                    const stringLen = mssBuffer[7];
                    if (mssBuffer.length >= 8 + stringLen) {
                        desc = mssBuffer.slice(8, 8 + stringLen).toString('utf8');
                        desc = desc.replace(/[\x00-\x09\x0B-\x1F\x7F]+/g, '').trim();
                    }
                }
            }

            if (desc) {
                debugLog(`[ATSC ETT] Decoded Desc for Chan ${virtualChannel} Event ${eventId}`);
                db.run("UPDATE programs SET description = ? WHERE frequency = ? AND channel_service_id = ? AND event_id = ?",
                    [desc, freq, virtualChannel, eventId]);
            }
        } catch (e) {
            console.error('[ATSC ETT] Error:', e);
        }
    },

    parseDVBEIT(section, serviceId, onFound, freq) {
        try {
            const sectionLength = ((section[1] & 0x0F) << 8) | section[2];
            let evOffset = 14;

            while (evOffset < sectionLength - 1) {
                if (evOffset + 12 > section.length) break;

                const startTimeMJD = (section[evOffset + 2] << 8) | section[evOffset + 3];
                const startTimeBCD = (section[evOffset + 4] << 16) | (section[evOffset + 5] << 8) | section[evOffset + 6];
                const durationBCD = (section[evOffset + 7] << 16) | (section[evOffset + 8] << 8) | section[evOffset + 9];
                const descriptorsLength = ((section[evOffset + 10] & 0x0F) << 8) | section[evOffset + 11];

                if (evOffset + 12 + descriptorsLength > section.length) break;

                const startTime = this.parseDVBTime(startTimeMJD, startTimeBCD);
                const durationSec = (((durationBCD >> 16) & 0x0F) * 3600) + (((durationBCD >> 20) & 0x0F) * 36000) +
                    (((durationBCD >> 8) & 0x0F) * 60) + (((durationBCD >> 12) & 0x0F) * 600) +
                    ((durationBCD & 0x0F)) + (((durationBCD >> 4) & 0x0F) * 10);

                const endTime = startTime + durationSec * 1000;

                let descOffset = evOffset + 12;
                let title = '';
                let desc = '';

                while (descOffset < evOffset + 12 + descriptorsLength) {
                    const tag = section[descOffset];
                    const len = section[descOffset + 1];

                    if (tag === 0x4D) { // Short Event
                        let titleLen = section[descOffset + 3];
                        let titleStart = descOffset + 4;
                        if (section[titleStart] < 0x20) { titleStart++; titleLen--; }
                        title = section.slice(titleStart, titleStart + titleLen).toString('utf8').replace(/[^\x20-\x7E]/g, '');
                    } else if (tag === 0x4E) { // Extended Event
                        if (!desc) {
                            let textOffset = descOffset + 2;
                            if (textOffset + 3 < descOffset + 2 + len) {
                                textOffset += 3;
                                let remainingLen = (descOffset + 2 + len) - textOffset;
                                if (remainingLen > 0) {
                                    desc = section.slice(textOffset, textOffset + remainingLen).toString('utf8').trim();
                                }
                            }
                        }
                    }
                    descOffset += 2 + len;
                }

                if (title && startTime > 0) {
                    onFound();
                    db.run(`INSERT INTO programs (frequency, channel_service_id, start_time, end_time, title, description) 
                            VALUES (?, ?, ?, ?, ?, ?)
                            ON CONFLICT(frequency, channel_service_id, start_time) 
                            DO UPDATE SET title=excluded.title, end_time=excluded.end_time, description=excluded.description`,
                        [freq, serviceId.toString(), startTime, endTime, title, desc]);
                }

                evOffset += 12 + descriptorsLength;
            }
        } catch (e) {
            console.error('[DVB EPG] Error:', e);
        }
    }
};

module.exports = EPG;
