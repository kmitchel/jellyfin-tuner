const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const dbPath = 'epg.db';
const dbExists = fs.existsSync(dbPath);
const db = new sqlite3.Database(dbPath);

// Initialize EPG Database
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS programs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_service_id TEXT,
        start_time INTEGER,
        end_time INTEGER,
        title TEXT,
        description TEXT,
        event_id INTEGER,
        source_id INTEGER,
        UNIQUE(channel_service_id, start_time)
    )`);
    // Graceful migrations for existing DBs
    db.run("ALTER TABLE programs ADD COLUMN event_id INTEGER", () => { });
    db.run("ALTER TABLE programs ADD COLUMN source_id INTEGER", () => { });
});

const app = express();
app.use(express.static('public'));
const PORT = process.env.PORT || 3000;

// Tuner Configuration
// Adjust these adapter paths based on your system (e.g., /dev/dvb/adapter0, /dev/dvb/adapter1)
// Tuner Configuration: Dynamic Discovery
let TUNERS = [];
try {
    if (fs.existsSync('/dev/dvb')) {
        const files = fs.readdirSync('/dev/dvb');
        const adapters = files.filter(f => f.startsWith('adapter'));

        // Sort adapters (adapter0, adapter1...)
        adapters.sort((a, b) => {
            const numA = parseInt(a.replace('adapter', ''), 10);
            const numB = parseInt(b.replace('adapter', ''), 10);
            return numA - numB;
        });

        TUNERS = adapters.map(name => {
            const id = parseInt(name.replace('adapter', ''), 10);
            return { id: id, adapter: `/dev/dvb/${name}`, inUse: false };
        });
        console.log(`Discovered ${TUNERS.length} tuners: ${TUNERS.map(t => t.adapter).join(', ')}`);
    } else {
        console.warn('/dev/dvb not found. Mocking 2 tuners for development.');
        TUNERS = [
            { id: 0, adapter: '/dev/dvb/adapter0', inUse: false },
            { id: 1, adapter: '/dev/dvb/adapter1', inUse: false }
        ];
    }
} catch (e) {
    console.error('Failed to discover tuners:', e);
    // Fallback
    TUNERS = [
        { id: 0, adapter: '/dev/dvb/adapter0', inUse: false },
        { id: 1, adapter: '/dev/dvb/adapter1', inUse: false }
    ];
}

const CHANNELS_CONF = process.env.CHANNELS_CONF || path.resolve(process.cwd(), 'channels.conf');
const ENABLE_PREEMPTION = process.env.ENABLE_PREEMPTION === 'true'; // Default: false
const ENABLE_TRANSCODING = process.env.ENABLE_TRANSCODING !== 'false'; // Default: true
const ENABLE_QSV = process.env.ENABLE_QSV === 'true'; // Default: false
const VERBOSE_LOGGING = process.env.VERBOSE_LOGGING === 'true'; // Default: false

function debugLog(...args) {
    if (VERBOSE_LOGGING) console.log(...args);
}

// Dynamic Channel Loader
let CHANNELS = [];
let lastTunerIndex = -1; // For Round-Robin selection




function loadChannels() {
    console.log(`Loading channels from ${CHANNELS_CONF}...`);
    try {
        if (!require('fs').existsSync(CHANNELS_CONF)) {
            console.warn('Channels config not found, using empty list.');
            return;
        }

        const data = require('fs').readFileSync(CHANNELS_CONF, 'utf8');
        const entries = data.split('[');

        // Load logos if logos.json exists
        let logos = {};
        try {
            const logoPath = path.resolve(process.cwd(), 'logos.json');
            if (fs.existsSync(logoPath)) {
                logos = JSON.parse(fs.readFileSync(logoPath, 'utf8'));
                console.log(`[Config] Loaded ${Object.keys(logos).length} icons from logos.json`);
            }
        } catch (e) {
            console.warn('[Config] Failed to parse logos.json:', e);
        }

        CHANNELS = [];

        entries.forEach(entry => {
            if (!entry.trim()) return;
            const lines = entry.split('\n');
            const name = lines[0].replace(']', '').trim();
            const serviceIdLine = lines.find(l => l.trim().startsWith('SERVICE_ID'));
            const vChannelLine = lines.find(l => l.trim().startsWith('VCHANNEL'));
            const freqLine = lines.find(l => l.trim().startsWith('FREQUENCY'));

            if (serviceIdLine && vChannelLine) {
                let serviceId = serviceIdLine.split('=')[1].trim();
                const vChannel = vChannelLine.split('=')[1].trim();
                const frequency = freqLine ? freqLine.split('=')[1].trim() : null;

                // Normalize serviceId to decimal string (handles 0x hex if present)
                serviceId = parseInt(serviceId, serviceId.startsWith('0x') ? 16 : 10).toString();

                CHANNELS.push({
                    number: vChannel,
                    name: name,
                    serviceId: serviceId,
                    frequency: frequency,
                    icon: logos[vChannel] || logos[name] || null,
                    rawConfig: `[${name}]\n${entry.substring(entry.indexOf(']') + 1).trim()}`
                });
            }
        });



        console.log(`Loaded ${CHANNELS.length} channels:`);
        CHANNELS.forEach(c => console.log(`  - ${c.name} (Service ID: ${c.serviceId}, Chan: ${c.number})`));

        // Sort by channel number
        CHANNELS.sort((a, b) => parseFloat(a.number) - parseFloat(b.number));

    } catch (e) {
        console.error('Failed to parse channels.conf:', e);
    }
}

// Load immediately
loadChannels();

// Helper: Promise-based delay
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Helper: Escape XML special characters
function escapeXml(unsafe) {
    if (!unsafe) return "";
    return unsafe.replace(/[<>&'"]/g, function (c) {
        switch (c) {
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '&': return '&amp;';
            case '\'': return '&apos;';
            case '"': return '&quot;';
            default: return c;
        }
    });
}

// Helper: Format date for XMLTV (Pure UTC for maximum compatibility)
function formatXmltvDate(ts) {
    const d = new Date(ts);
    const pad = n => n < 10 ? '0' + n : n;
    return d.getUTCFullYear() +
        pad(d.getUTCMonth() + 1) +
        pad(d.getUTCDate()) +
        pad(d.getUTCHours()) +
        pad(d.getUTCMinutes()) +
        pad(d.getUTCSeconds()) +
        ' +0000';
}

// Helper: Get latest logos from logos.json
function getLatestLogos() {
    try {
        const logoPath = path.resolve(process.cwd(), 'logos.json');
        if (fs.existsSync(logoPath)) {
            return JSON.parse(fs.readFileSync(logoPath, 'utf8'));
        }
    } catch (e) {
        console.warn('[Config] Failed to parse logos.json:', e);
    }
    return {};
}

// Helper: Acquire an available tuner, preempting if necessary
async function acquireTuner() {
    // 1. Try Round-Robin to find a free tuner that wasn't the last one used
    for (let i = 0; i < TUNERS.length; i++) {
        const nextIndex = (lastTunerIndex + 1 + i) % TUNERS.length;
        const potentialTuner = TUNERS[nextIndex];
        if (!potentialTuner.inUse) {
            lastTunerIndex = nextIndex;
            return potentialTuner;
        }
    }

    // 2. If all busy, try to preempt one 
    if (ENABLE_PREEMPTION) {
        const preemptIndex = (lastTunerIndex + 1) % TUNERS.length;
        const tuner = TUNERS[preemptIndex];

        if (tuner && !tuner.epgScanning) { // Don't preempt EPG scan, it releases soon anyway
            console.log(`Preempting Tuner ${tuner.id} for new request...`);
            if (tuner.killSwitch) {
                tuner.killSwitch();
            }
            // Wait for it to become free (max 3s)
            for (let i = 0; i < 15; i++) {
                if (!tuner.inUse) {
                    lastTunerIndex = preemptIndex;
                    return tuner;
                }
                await delay(200);
            }
        }
    }

    // 3. Last ditch: wait for any tuner 
    for (let i = 0; i < 10; i++) {
        for (let j = 0; j < TUNERS.length; j++) {
            const idx = (lastTunerIndex + 1 + j) % TUNERS.length;
            if (!TUNERS[idx].inUse) {
                lastTunerIndex = idx;
                return TUNERS[idx];
            }
        }
        await delay(500);
    }

    return null;
}

// Setup database tables with improved migration/initialization
db.serialize(() => {
    db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='programs'", (err, row) => {
        if (err) {
            console.error('[DB] Error checking for table:', err);
            return;
        }

        if (row) {
            // Table exists, check if migration is needed
            db.all("PRAGMA table_info(programs)", (err, columns) => {
                if (err || !columns) return;
                const hasFrequency = columns.some(c => c.name === 'frequency');
                if (!hasFrequency) {
                    console.log('[DB] Old database detected. Migrating to frequency-aware schema...');
                    db.serialize(() => {
                        db.run("BEGIN TRANSACTION");
                        db.run("ALTER TABLE programs RENAME TO programs_old");
                        db.run(`CREATE TABLE programs (
                            frequency TEXT,
                            channel_service_id TEXT,
                            start_time INTEGER,
                            end_time INTEGER,
                            title TEXT,
                            description TEXT,
                            event_id INTEGER,
                            source_id INTEGER,
                            PRIMARY KEY (frequency, channel_service_id, start_time)
                        )`);
                        db.run("INSERT INTO programs (frequency, channel_service_id, start_time, end_time, title, description, event_id, source_id) SELECT 'unknown', channel_service_id, start_time, end_time, title, description, event_id, source_id FROM programs_old");
                        db.run("DROP TABLE programs_old");
                        db.run("CREATE INDEX IF NOT EXISTS idx_end_time ON programs(end_time)");
                        db.run("COMMIT", (err) => {
                            if (err) console.error('[DB] Migration failed:', err);
                            else console.log('[DB] Migration completed successfully.');
                        });
                    });
                }
            });
        } else {
            // New database, create fresh
            console.log('[DB] Creating fresh programs table...');
            db.serialize(() => {
                db.run(`CREATE TABLE IF NOT EXISTS programs (
                    frequency TEXT,
                    channel_service_id TEXT,
                    start_time INTEGER,
                    end_time INTEGER,
                    title TEXT,
                    description TEXT,
                    event_id INTEGER,
                    source_id INTEGER,
                    PRIMARY KEY (frequency, channel_service_id, start_time)
                )`);
                db.run(`CREATE INDEX IF NOT EXISTS idx_end_time ON programs(end_time)`);
            });
        }
    });
});

// EPG Modle
const EPG = {
    lastScan: 0,
    isScanning: false,
    isInitialScanDone: false,
    sourceMap: new Map(), // ATSC Mapping: "freq_sourceId" -> channelNumber (e.g., "500000000_1" -> "15.1")

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
            CHANNELS.forEach(c => {
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
            // ... Sync Check omitted ...
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
            this.parseDVBEIT(section, id, onFound);
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
                    // ATSC A/65 Table 6.7: 10-bit major, 10-bit minor
                    // Byte 14: reserved(4), major(4 high)
                    // Byte 15: major(6 low), minor(2 high)
                    // Byte 16: minor(8 low)
                    const major = ((section[offset + 14] & 0x0F) << 6) | (section[offset + 15] >> 2);
                    const minor = ((section[offset + 15] & 0x03) << 8) | section[offset + 16];
                    const virtualChannel = `${major}.${minor}`;

                    // Match logic:
                    // 1. High Precision: Match by Frequency AND Virtual Channel Number (Most reliable)
                    let channel = CHANNELS.find(c => c.frequency == freq && c.number === virtualChannel);

                    // 2. Fallback: Match by Frequency AND ServiceID (Program Number)
                    if (!channel) {
                        channel = CHANNELS.find(c => c.frequency == freq && c.serviceId == programNumber.toString());
                    }

                    // 3. Last Resort: Global Virtual Channel match (for redundancy)
                    if (!channel) {
                        channel = CHANNELS.find(c => c.number === virtualChannel);
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
            // ATSC EIT header is 10 bytes (table_id to num_events_in_section)
            // section[0] table_id
            // section[1-2] section_length
            // section[3-4] source_id
            // section[5] version_number, current_next_indicator
            // section[6] section_number
            // section[7] last_section_number
            // section[8] protocol_version
            // section[9] num_events_in_section
            const numEvents = section[9];
            // console.log(`[ATSC DEBUG] Header: SourceID=${sourceId}, NumEvents=${numEvents}, Len=${sectionLength}`);
            let offset = 10; // Start of event loop

            if (numEvents > 0) {
                // console.log(`[ATSC EIT] Parsing ${numEvents} events for SourceID ${sourceId} (Table 0x${section[0].toString(16)})`);
            }

            for (let i = 0; i < numEvents; i++) {
                // Check if enough bytes remain for event_id, start_time, duration, title_length
                if (offset + 10 > sectionLength + 3) {
                    debugLog(`[ATSC DEBUG] Offset overflow at event ${i}: ${offset} > ${sectionLength}`);
                    break;
                }

                const eventId = ((section[offset] & 0x3F) << 8) | section[offset + 1];
                const startTimeGPS = section.readUInt32BE(offset + 2);
                const duration = ((section[offset + 6] & 0x0F) << 16) | (section[offset + 7] << 8) | section[offset + 8];
                const titleLength = section[offset + 9];

                // console.log(`[ATSC DEBUG] Evt ${eventId}: Start=${startTimeGPS} Dur=${duration} TitleLen=${titleLength}`);

                // GPS Epoch 1980-01-06 00:00:00 UTC. diff 315964800
                // Subtracting 18 seconds to convert GPS time to UTC time (Leap Seconds)
                const startTime = (startTimeGPS + 315964800 - 18) * 1000;
                const endTime = startTime + duration * 1000;

                let title = '';
                let description = '';
                let currentEventOffset = offset + 10;

                // Parse title (Multi-String Structure)
                if (titleLength > 0 && currentEventOffset + titleLength <= section.length) {
                    let titleBuffer = section.slice(currentEventOffset, currentEventOffset + titleLength);

                    if (titleBuffer.length > 0) {
                        const numStrings = titleBuffer[0];
                        let stringOffset = 1;
                        // MSS: numStrings(1) + Lang(3) + Segments(1) + Comp(1) + Mode(1) + Len(1) + Text
                        // Total header size for first segment is 1+3+1+1+1+1 = 8 bytes.
                        if (numStrings > 0 && titleBuffer.length >= stringOffset + 7) {
                            const stringLen = titleBuffer[stringOffset + 6];   // Index 7 (Len)
                            // console.log(`[ATSC DEBUG] MSS String 0: Len=${stringLen}`);
                            if (titleBuffer.length >= stringOffset + 7 + stringLen) {
                                title = titleBuffer.slice(stringOffset + 7, stringOffset + 7 + stringLen).toString('utf8');
                                title = title.replace(/[\x00-\x09\x0B-\x1F\x7F]+/g, '').trim();
                                debugLog(`[ATSC DEBUG] Decoded Title: "${title}"`);
                            }
                        }
                    }
                }

                currentEventOffset += titleLength;

                // Descriptors... 
                if (currentEventOffset + 2 <= section.length - 4) {
                    const descriptorsLength = ((section[currentEventOffset] & 0x0F) << 8) | section[currentEventOffset + 1];
                    currentEventOffset += 2;
                    if (currentEventOffset + descriptorsLength <= section.length - 4) {
                        currentEventOffset += descriptorsLength;
                    } else {
                        // Descriptors overflow
                        currentEventOffset = section.length - 4;
                    }
                } else {
                    // No room for desc length (often just padding before CRC)
                    currentEventOffset = section.length - 4;
                }

                if (title && startTime > 0) {
                    onFound();
                    db.run(`INSERT INTO programs (frequency, channel_service_id, start_time, end_time, title, description, event_id, source_id) 
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                            ON CONFLICT(frequency, channel_service_id, start_time) 
                            DO UPDATE SET title=excluded.title, end_time=excluded.end_time, event_id=excluded.event_id, source_id=excluded.source_id`,
                        [freq, virtualChannel, startTime, endTime, title, description, eventId, sourceId]);
                } else {
                    debugLog(`[ATSC DEBUG] Skipped: Title="${title}" Start=${startTime}`);
                }

                offset = currentEventOffset; // Move to the start of the next event
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
            // MSS starts at offset 13 
            const mssBuffer = section.slice(13, sectionLength + 3 - 4);
            if (mssBuffer.length > 5) {
                const numStrings = mssBuffer[0];
                if (numStrings > 0) {
                    const stringLen = mssBuffer[7]; // num_strings(1) + lang(3) + num_segs(1) + comp(1) + mode(1) + len(1) = 8th byte
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
    parseDVBEIT(section, serviceId, onFound) {
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

                    if (tag === 0x4D) { // DVB Short Event Descriptor (Title)
                        let titleLen = section[descOffset + 3];
                        let titleStart = descOffset + 4;
                        // Handle potential leading compression_type or mode_byte
                        if (section[titleStart] < 0x20) { titleStart++; titleLen--; }
                        title = section.slice(titleStart, titleStart + titleLen).toString('utf8').replace(/[^\x20-\x7E]/g, '');
                    } else if (tag === 0x4E) { // DVB Extended Event Descriptor (Description)
                        // For simplicity, just grab the first description text
                        if (!desc) {
                            let textOffset = descOffset + 2;
                            // Skip descriptor_number, last_descriptor_number, language_code, length_of_items, items
                            // and get to length_of_text and text_char
                            // This is a simplified parse, a full parse would iterate through items
                            if (textOffset + 3 < descOffset + 2 + len) { // Check for language code
                                textOffset += 3; // Skip language_code
                                // Skip length_of_items and items loop for now
                                // Just try to find the text part
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
                    // console.log(`[DVB EPG] Parsed: "${title}" for Service ID: ${serviceId}`);
                    db.run("INSERT OR REPLACE INTO programs (channel_service_id, start_time, end_time, title, description) VALUES (?, ?, ?, ?, ?)",
                        [serviceId.toString(), startTime, endTime, title, desc]);
                }

                evOffset += 12 + descriptorsLength;
            }
        } catch (e) {
            console.error('[DVB EPG] Error:', e);
        }
    }
};

// Schedule EPG grab every 15 minutes (Longer scan to get more data)
setInterval(() => EPG.grab(60000), 15 * 60 * 1000);
// Priority: Initial grab on startup ONLY if database is missing
if (!dbExists) {
    console.log('[EPG] epg.db not found. Starting initial full scan...');
    EPG.grab();
} else {
    console.log('[EPG] epg.db found. Skipping initial scan (will refresh in 15m).');
    EPG.isInitialScanDone = true;
}

app.get('/images', (req, res) => {
    const imagesDir = path.resolve(__dirname, 'public', 'images');
    if (!fs.existsSync(imagesDir)) return res.status(404).send('Images directory not found');

    fs.readdir(imagesDir, (err, files) => {
        if (err) return res.status(500).send('Error reading images directory');
        let html = `<html><head><title>Hosted Images</title><style>
            body { font-family: sans-serif; background: #0f172a; color: white; padding: 2rem; }
            ul { list-style: none; padding: 0; }
            li { margin: 0.5rem 0; }
            a { color: #6366f1; text-decoration: none; }
            a:hover { text-decoration: underline; }
        </style></head><body><h1>Hosted Images</h1><ul>`;
        files.forEach(file => {
            html += `<li><a href="/images/${file}">${file}</a></li>`;
        });
        html += '</ul><br><a href="/">Back to Dashboard</a></body></html>';
        res.send(html);
    });
});

// Generate M3U Playlist
app.get('/lineup.m3u', (req, res) => {
    let m3u = '#EXTM3U\n';
    const host = req.headers.host;
    const currentLogos = getLatestLogos();

    CHANNELS.forEach(channel => {
        const icon = currentLogos[channel.number] || currentLogos[channel.name] || channel.icon;
        let logoAttr = icon ? ` tvg-logo="${icon}"` : "";
        m3u += `#EXTINF:-1 tvg-id="${channel.number}" tvg-name="${channel.name}"${logoAttr},${channel.number} ${channel.name}\n`;
        m3u += `http://${host}/stream/${channel.number}\n`;
    });

    res.set('Content-Type', 'audio/x-mpegurl');
    res.send(m3u);
});

// XMLTV Endpoint
app.get('/xmltv.xml', (req, res) => {
    db.all("SELECT * FROM programs WHERE end_time > ? ORDER BY frequency, channel_service_id, start_time", [Date.now()], (err, rows) => {
        if (err) {
            console.error(err);
            return res.status(500).send(err.message);
        }
        console.log(`[XMLTV] Serving ${rows.length} programs.`);

        const currentLogos = getLatestLogos();
        let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
        xml += '<tv>\n';

        // Channels
        CHANNELS.forEach(c => {
            const icon = currentLogos[c.number] || currentLogos[c.name] || c.icon;
            xml += `  <channel id="${c.number}">\n`;
            xml += `    <display-name>${escapeXml(c.name)}</display-name>\n`;
            if (icon) xml += `    <icon src="${escapeXml(icon)}" />\n`;
            xml += '  </channel>\n';
        });

        // Programs
        rows.forEach(p => {
            // Find channel using both frequency and ID to avoid mux collisions
            const channel = CHANNELS.find(c => {
                const freqMatch = !p.frequency || p.frequency === 'unknown' || c.frequency === p.frequency;
                const idMatch = c.number === p.channel_service_id || c.serviceId === p.channel_service_id;
                return freqMatch && idMatch;
            });

            if (!channel) return;

            const start = formatXmltvDate(p.start_time);
            const end = formatXmltvDate(p.end_time);

            xml += `  <programme start="${start}" stop="${end}" channel="${channel.number}">\n`;
            xml += `    <title lang="en">${escapeXml(p.title)}</title>\n`;
            if (p.description) xml += `    <desc lang="en">${escapeXml(p.description)}</desc>\n`;
            xml += '  </programme>\n';
        });

        xml += '</tv>';
        res.set('Content-Type', 'application/xml');
        res.send(xml);
    });
});

// Stream Endpoint
app.get('/stream/:channelNum', async (req, res) => {
    if (!EPG.isInitialScanDone) {
        return res.status(503).send('Service Unavailable: Initial EPG scan in progress. Please wait a few minutes.');
    }

    const channelNum = req.params.channelNum;
    const channel = CHANNELS.find(c => c.number === channelNum);

    if (!channel) {
        return res.status(404).send('Channel not found');
    }

    // Acquire any available tuner
    const tuner = await acquireTuner();

    if (!tuner) {
        return res.status(503).send('No tuners available');
    }

    console.log(`Acquired Tuner ${tuner.id} for ${channel.name}`);
    console.log(`Starting stream for ${channel.name} on Tuner ${tuner.id}`);
    tuner.inUse = true;
    tuner.processes = {};

    // Allow the hardware connection to settle before retuning
    // Increased to 1000ms to reduce power contention on dual USB tuners
    await delay(1000);

    // Use '-o -' to pipe the MPEG-TS stream to stdout. 
    // This avoids 'Device or resource busy' errors on /dev/dvb/.../dvr0
    const zap = spawn('dvbv5-zap', [
        '-c', CHANNELS_CONF,
        '-r',
        '-a', tuner.id,
        '-o', '-',
        channel.number
    ]);
    tuner.processes.zap = zap;

    zap.on('error', (err) => {
        console.error(`Tuner ${tuner.id} zap error:`, err);
        cleanup();
        if (!res.headersSent) res.status(500).send('Tuner error');
    });

    // 2. Start ffmpeg to read from stdin (piped from zap)

    // Global/Base Args
    const ffmpegArgs = [];

    if (ENABLE_TRANSCODING && ENABLE_QSV) {
        ffmpegArgs.push('-init_hw_device', 'qsv=hw', '-filter_hw_device', 'hw');
    }

    ffmpegArgs.push(
        '-fflags', '+genpts+discardcorrupt',
        '-err_detect', 'ignore_err',
        '-analyzeduration', '2000000',
        '-probesize', '2000000',
        '-i', 'pipe:0'
    );

    if (ENABLE_TRANSCODING) {
        if (ENABLE_QSV) {
            // Hardware Transcoding (Intel QSV)
            // 1. Software deinterlace
            // 2. Ensure NV12 format
            // 3. Upload to hardware with explicit format=qsv
            // Note: 'hwupload_qsv' is often missing in some builds, 'hwupload' is more universal
            ffmpegArgs.push(
                '-vf', 'yadif=0:-1:0,format=nv12,hwupload=extra_hw_frames=64,format=qsv',
                '-c:v', 'h264_qsv',
                '-preset', 'veryfast',
                '-global_quality', '23',
                '-b:v', '5M',
                '-maxrate', '6M',
                '-bufsize', '12M',
                '-c:a', 'aac',
                '-b:a', '128k',
                '-ac', '2'
            );
        } else {
            // Software Transcoding (H.264/AAC)
            ffmpegArgs.push(
                '-c:v', 'libx264',
                '-preset', 'ultrafast',
                '-tune', 'zerolatency',
                '-vf', 'yadif=0:-1:0',
                '-crf', '23',
                '-maxrate', '5M',
                '-bufsize', '10M',
                '-c:a', 'aac',
                '-b:a', '128k',
                '-ac', '2'
            );
        }
    } else {
        // Stream Copy (Pass-through)
        ffmpegArgs.push('-c', 'copy');
    }

    // Output format
    ffmpegArgs.push('-f', 'mpegts', 'pipe:1');

    debugLog(`Spawning FFmpeg with args: ${ffmpegArgs.join(' ')}`);
    const ffmpeg = spawn('ffmpeg', ffmpegArgs);
    tuner.processes.ffmpeg = ffmpeg;

    // Pipe zap stdout -> ffmpeg stdin
    // Handle EPIPE on ffmpeg stdin (e.g. if ffmpeg fails to start or dies)
    ffmpeg.stdin.on('error', (err) => {
        if (err.code !== 'EPIPE') {
            console.error(`FFmpeg stdin error [Tuner ${tuner.id}]:`, err);
        }
    });

    zap.stdout.pipe(ffmpeg.stdin).on('error', (err) => {
        console.warn(`Zap stdout pipe error [Tuner ${tuner.id}]:`, err);
        cleanup();
    });

    res.on('error', (err) => {
        console.warn(`Response socket error [Tuner ${tuner.id}]:`, err);
        cleanup();
    });

    res.writeHead(200, {
        'Content-Type': 'video/mp2t',
        'Connection': 'keep-alive'
    });

    // Connection Watchdog
    // If the client stops reading data (e.g. mpv left open but paused/broken),
    // the pipe will backpressure and ffmpeg will stop emitting data.
    if (tuner.watchdogInterval) clearInterval(tuner.watchdogInterval);

    tuner.lastActivity = Date.now();
    tuner.watchdogInterval = setInterval(() => {
        if (tuner.cleaningUp) return; // Don't fire if already cleaning up

        const inactivity = Date.now() - tuner.lastActivity;
        if (inactivity > 30000) { // 30s timeout
            console.warn(`[Tuner ${tuner.id}] Watchdog: Client stalled for ${Math.round(inactivity / 1000)}s - releasing.`);
            // STOP THE WATCHDOG IMMEDIATELY to prevent spam
            if (tuner.watchdogInterval) {
                clearInterval(tuner.watchdogInterval);
                tuner.watchdogInterval = null;
            }
            cleanup();
        }
    }, 5000);

    // Update activity on every data chunk sent to client
    ffmpeg.stdout.on('data', () => {
        tuner.lastActivity = Date.now();
    });

    // Handle ffmpeg output pipe errors (e.g. client disconnect)
    ffmpeg.stdout.on('error', (err) => {
        if (err.code === 'EPIPE' || err.code === 'ECONNRESET') {
            console.log(`FFmpeg EPIPE/ECONNRESET [Tuner ${tuner.id}] - client likely disconnected`);
            cleanup();
        } else {
            console.error(`FFmpeg stdout error [Tuner ${tuner.id}]:`, err);
        }
    });

    ffmpeg.stdout.pipe(res).on('error', (err) => {
        console.warn(`Response pipe error [Tuner ${tuner.id}]:`, err);
        cleanup();
    });

    // Logging helpers
    ffmpeg.stderr.on('data', (data) => console.log(`FFmpeg [Tuner ${tuner.id}]: ${data}`));
    zap.stderr.on('data', (data) => console.log(`Zap [Tuner ${tuner.id}]: ${data}`));

    // Cleanup function
    const cleanup = () => {
        // Always clear watchdog first to prevent infinite loops/spam
        if (tuner.watchdogInterval) {
            clearInterval(tuner.watchdogInterval);
            tuner.watchdogInterval = null;
        }

        if (tuner.cleaningUp) return;
        tuner.cleaningUp = true;

        console.log(`Cleaning up Tuner ${tuner.id}`);

        // Remove the killSwitch reference so we don't call it again
        tuner.killSwitch = null;

        // Kill processes as aggressively as possible
        console.log(`Sending SIGKILL to Tuner ${tuner.id} processes...`);
        if (tuner.processes.zap) {
            try { tuner.processes.zap.kill('SIGKILL'); } catch (e) { }
        }
        if (tuner.processes.ffmpeg) {
            try { tuner.processes.ffmpeg.kill('SIGKILL'); } catch (e) { }
        }

        // Safety timeout to force release state if exit handler doesn't fire
        const forceReleaseTimeout = setTimeout(() => {
            console.warn(`Force releasing Tuner ${tuner.id} state (cleanup timeout)`);
            tuner.inUse = false;
            tuner.cleaningUp = false;
            tuner.processes = {};
        }, 1000);

        // Allow one final clearing of timeout if zap exits cleanly before timeout
        tuner.forceReleaseTimeout = forceReleaseTimeout;

    };

    // Attach killSwitch for preemption
    tuner.killSwitch = cleanup;

    // release tuner only when zap exits (lock released)
    zap.on('exit', (code, signal) => {
        console.log(`Zap exited [Tuner ${tuner.id}] (code: ${code}, signal: ${signal})`);

        if (tuner.forceReleaseTimeout) {
            clearTimeout(tuner.forceReleaseTimeout);
            tuner.forceReleaseTimeout = null;
        }

        // Always mark free on zap exit, as the hardware lock is definitely gone
        tuner.inUse = false;
        tuner.cleaningUp = false;
        tuner.killSwitch = null;
        tuner.processes = {};
        console.log(`Tuner ${tuner.id} marked as FREE`);
    });

    ffmpeg.on('exit', (code) => {
        debugLog(`FFmpeg exited [Tuner ${tuner.id}] with code ${code}`);
        // If ffmpeg dies, we must kill zap to stop tuning
        cleanup();
    });

    // Client disconnect handling
    const onDisconnect = () => {
        console.log(`Client disconnected (socket close) [Tuner ${tuner.id}]`);
        cleanup();
    };
    req.on('close', onDisconnect);
    res.on('close', onDisconnect);

    // Handle zap errors
    zap.on('error', (err) => {
        console.error(`Tuner ${tuner.id} zap error:`, err);
        cleanup();
    });
});

app.listen(PORT, () => {
    console.log(`Tuner app listening at http://localhost:${PORT}`);
});

// Global Cleanup on App Exit
function cleanExit() {
    console.log('\nApp stopping, ensuring all tuners are released...');
    TUNERS.forEach(tuner => {
        if (tuner.inUse && tuner.processes) {
            console.log(`Killing processes for Tuner ${tuner.id}`);
            if (tuner.processes.zap) try { tuner.processes.zap.kill('SIGKILL'); } catch (e) { }
            if (tuner.processes.ffmpeg) try { tuner.processes.ffmpeg.kill('SIGKILL'); } catch (e) { }
        }
    });
    process.exit();
}

process.on('SIGINT', cleanExit);
process.on('SIGTERM', cleanExit);
