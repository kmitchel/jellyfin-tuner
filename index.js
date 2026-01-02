const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('epg.db');

// Initialize EPG Database
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS programs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_service_id TEXT,
        start_time INTEGER,
        end_time INTEGER,
        title TEXT,
        description TEXT,
        UNIQUE(channel_service_id, start_time, title)
    )`);
});

const app = express();
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

const CHANNELS_CONF = process.env.CHANNELS_CONF || '/etc/dvb/channels.conf';
const ENABLE_PREEMPTION = process.env.ENABLE_PREEMPTION === 'true'; // Default: false
const ENABLE_TRANSCODING = process.env.ENABLE_TRANSCODING !== 'false'; // Default: true
const ENABLE_QSV = process.env.ENABLE_QSV === 'true'; // Default: false

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
                    rawConfig: `[${name}]\n${entry.substring(entry.indexOf(']') + 1).trim()}` // Ensure clean newline after header
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

// EPG Modle
const EPG = {
    lastScan: 0,
    isScanning: false,
    isInitialScanDone: false,
    sourceMap: new Map(), // ATSC: source_id -> program_number (serviceId)

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

    async grab() {
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
                    if (!muxMap.has(c.frequency)) muxMap.set(c.frequency, c.name);
                }
            });

            const frequencies = Array.from(muxMap.keys());

            for (const freq of frequencies) {
                console.log(`[EPG Verbose] Checking availability for freq ${freq}...`);
                // Re-check tuner status before each mux
                const tuner = TUNERS.find(t => !t.inUse);
                if (!tuner) {
                    console.log('[EPG Verbose] No tuners available for this mux.');
                    break;
                }

                tuner.inUse = true;
                tuner.epgScanning = true;
                const channelName = muxMap.get(freq);

                console.log(`[EPG] Scanning mux at ${freq} Hz using ${channelName} on Tuner ${tuner.id}...`);

                try {
                    await this.scanMux(tuner, channelName);
                } catch (e) {
                    console.error(`[EPG] Error scanning mux at ${freq}:`, e);
                }

                tuner.inUse = false;
                tuner.epgScanning = false;
                console.log(`[EPG Verbose] Released Tuner ${tuner.id}`);

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

    scanMux(tuner, channelName) {
        return new Promise((resolve) => {
            const path = require('path');
            // Find the raw config for this channel to ensure zap finds it
            const channel = CHANNELS.find(c => c.name === channelName);
            const tempConf = path.resolve(__dirname, `epg_scan_${tuner.id}.conf`);

            if (channel && channel.rawConfig) {
                console.log(`[EPG Debug] Writing temp conf to ${tempConf} for channel '${channelName}' (len=${channelName.length})`);
                console.log(`[EPG Debug] Config content (JSON safe): ${JSON.stringify(channel.rawConfig)}`);
                fs.writeFileSync(tempConf, channel.rawConfig);
            } else {
                // Fallback to main conf if something weird happens (though muxMap comes from CHANNELS so this shouldn't fail)
                console.warn(`[EPG] Raw config not found for ${channelName}, using main conf.`);
                const fs = require('fs'); fs.copyFileSync(CHANNELS_CONF, tempConf);
            }

            const args = [
                '-c', tempConf,
                '-a', tuner.id,
                '-t', '15',
                '-o', '-',
                channelName
            ];

            console.log(`[EPG Debug] Spawning zap with args: ${JSON.stringify(args)}`);

            const zap = spawn('dvbv5-zap', args);

            let buffer = Buffer.alloc(0);
            let dataReceived = false;

            zap.stdout.on('data', (data) => {
                if (!dataReceived) {
                    console.log(`[EPG] Receiving data stream for ${channelName}...`);
                    dataReceived = true;
                }
                console.log(`[EPG Verbose] Received ${data.length} bytes chunk.`);
                buffer = Buffer.concat([buffer, data]);
                if (buffer.length > 15 * 1024 * 1024) { // 15MB limit for full mux scan
                    console.log('[EPG Verbose] Buffer limit reached (15MB), killing zap.');
                    zap.kill('SIGKILL');
                }
            });

            zap.stderr.on('data', (d) => {
                console.log(`[EPG Debug] Zap stderr: ${d.toString()}`);
            });

            const timeout = setTimeout(() => {
                if (!dataReceived) console.warn(`[EPG] No data received for ${channelName} after 15s. Signal might be weak.`);
                zap.kill('SIGKILL');
            }, 15000); // 15s per mux

            zap.on('exit', () => {
                clearTimeout(timeout);
                const count = this.parseEIT(buffer);
                console.log(`[EPG] Mux scan finished. Discovered ${count} program entries.`);
                resolve();
            });
        });
    },

    parseEIT(buffer) {
        let programCount = 0;
        let sections = new Map(); // Track sections by PID and TableID to reassemble

        console.log(`[EPG] Beginning parse of ${buffer.length} bytes...`);
        const pidCounts = new Map();
        const tableCounts = new Map();

        for (let i = 0; i < buffer.length - 188; i += 188) {
            if (buffer[i] !== 0x47) {
                let next = buffer.indexOf(0x47, i);
                if (next === -1) break;
                i = next;
                if (i > buffer.length - 188) break;
            }

            const pid = ((buffer[i + 1] & 0x1F) << 8) | buffer[i + 2];

            // Track all PIDs for detailed debugging
            pidCounts.set(pid, (pidCounts.get(pid) || 0) + 1);

            // ATSC PSIP (0x1FFB=8187) is the Master Guide Table/Base PID
            // DVB EIT (0x12=18)
            const isGuidePid = (pid === 0x12 || pid === 0x1FFB);

            // For now, process EVERYTHING to find where the data is hiding
            // if (!isGuidePid) continue;

            const pusi = buffer[i + 1] & 0x40;
            const adaptation = (buffer[i + 3] & 0x30) >> 4;
            let payloadOffset = 4;
            if (adaptation === 2 || adaptation === 3) payloadOffset += buffer[i + 4] + 1;

            if (payloadOffset >= 188) continue;

            let payload = buffer.slice(i + payloadOffset, i + 188);

            // Handle PUSI (Start of a new section)
            if (pusi) {
                const pointer = payload[0];
                const sectionStart = payload.slice(pointer + 1);
                if (sectionStart.length < 3) continue;

                const tableId = sectionStart[0];

                // Verbose: Log every ATSC table found
                if (tableId >= 0xC7 && tableId <= 0xCF) {
                    console.log(`[EPG Verbose] Found ATSC Table ID: 0x${tableId.toString(16).toUpperCase()} on PID ${pid} (Section Len: ${sectionStart.length})`);
                    tableCounts.set(tableId, (tableCounts.get(tableId) || 0) + 1);
                }

                // Debug log for first few table IDs found
                if (programCount === 0 && sections.size < 5) {
                    console.log(`[EPG] Found Table ID: 0x${tableId.toString(16).toUpperCase()} on PID ${pid}`);
                    sections.set(tableId, true); // misuse map just to limit logs
                }

                // Support DVB EIT (0x4E-0x6F) and ATSC PSIP Tables (0xC7-0xCF)
                // 0xC7: MGT, 0xC8/C9: VCT, 0xCB: EIT-0, 0xCC: EIT-1...
                if (tableId === 0xC8 || tableId === 0xC9) {
                    console.log(`[EPG Verbose] Processing VCT Table 0x${tableId.toString(16)}`);
                    this.parseATSCVCT(sectionStart);
                } else if ((tableId >= 0x4E && tableId <= 0x6F) || (tableId >= 0xC7 && tableId <= 0xCF)) {
                    // console.log(`[EPG Verbose] Processing EIT Table 0x${tableId.toString(16)}`); // Can be very spammy
                    const id = (sectionStart[3] << 8) | sectionStart[4];
                    this.parseEITSection(sectionStart, id, () => programCount++);
                }
            }
        }

        // Detailed summary sorted by packet count
        const sortedPids = Array.from(pidCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10);
        console.log('[EPG] Top 10 PIDs found:', Object.fromEntries(sortedPids));
        console.log(`[EPG] Guide PIDs seen? DVB(18): ${pidCounts.get(18) || 0}, ATSC(8187): ${pidCounts.get(8187) || 0}`);

        const tableSummary = {};
        tableCounts.forEach((v, k) => tableSummary[`0x${k.toString(16).toUpperCase()}`] = v);
        console.log('[EPG] ATSC Tables found:', tableSummary);

        return programCount;
    },

    parseEITSection(section, id, onFound) {
        const tableId = section[0];
        const sectionLength = ((section[1] & 0x0F) << 8) | section[2];
        if (section.length < sectionLength + 3) return;

        if (tableId === 0xCB || tableId === 0xCC || tableId === 0xCD || tableId === 0xCE) {
            // In ATSC EIT, 'id' is SourceId. We need to map it to ServiceId (Program Number).
            let serviceId = this.sourceMap.get(id) || id.toString();
            this.parseATSCEIT(section, serviceId, onFound);
        } else if (tableId >= 0x4E && tableId <= 0x6F) {
            this.parseDVBEIT(section, id, onFound);
        }
    },

    parseATSCVCT(section) {
        try {
            const sectionLength = ((section[1] & 0x0F) << 8) | section[2];
            const numChannels = section[9];
            let offset = 10;

            for (let i = 0; i < numChannels; i++) {
                if (offset + 32 > sectionLength + 3) {
                    console.log(`[ATSC VCT] Section too short for channel at index ${i}`);
                    break;
                }
                // Channel name is 14 bytes (UTF-16)
                const major = ((section[offset + 14] & 0x0F) << 6) | (section[offset + 15] >> 2);
                const minor = ((section[offset + 15] & 0x03) << 8) | section[offset + 16];
                const programNumber = (section[offset + 18] << 8) | section[offset + 19];
                const sourceId = (section[offset + 22] << 8) | section[offset + 23];

                console.log(`[ATSC VCT Verbose] Channel ${i}: Major=${major}, Minor=${minor}, Program=${programNumber}, SourceID=${sourceId}`);

                if (sourceId && programNumber) {
                    if (!this.sourceMap.has(sourceId)) {
                        console.log(`[ATSC VCT] Mapped Source ID ${sourceId} -> Program ${programNumber} (${major}.${minor})`);
                        this.sourceMap.set(sourceId, programNumber.toString());
                    }
                }

                const descriptorsLength = ((section[offset + 30] & 0x0F) << 8) | section[offset + 31];
                offset += 32 + descriptorsLength;
            }
            console.log(`[ATSC VCT] Parsed ${numChannels} channels. Source Map size: ${this.sourceMap.size}`);
        } catch (e) {
            console.error('[ATSC VCT] Error:', e);
        }
    },

    parseATSCEIT(section, serviceId, onFound) {
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
            let offset = 10; // Start of event loop

            if (numEvents > 0) {
                console.log(`[ATSC EIT] Parsing ${numEvents} events for SourceID ${sourceId} / ServiceID ${serviceId} (Table 0x${section[0].toString(16)})`);
            }

            for (let i = 0; i < numEvents; i++) {
                // Check if enough bytes remain for event_id, start_time, duration, title_length
                if (offset + 10 > sectionLength + 3) {
                    console.log(`[EPG Verbose] Section too short for event at index ${i}`);
                    break;
                }

                const eventId = (section[offset] << 8) | section[offset + 1];
                const startTimeGPS = section.readUInt32BE(offset + 2);
                console.log(`[EPG Verbose] Event ${eventId}: StartGPS=${startTimeGPS}`);
                // length_in_seconds is 22 bits, ETM_location is 2 bits.
                const duration = ((section[offset + 6] & 0x3F) << 16) | (section[offset + 7] << 8) | section[offset + 8]; // Mask out ETM_location
                const titleLength = section[offset + 9];

                // GPS Epoch 1980-01-06 00:00:00 UTC. Unix Epoch 1970-01-01 00:00:00 UTC.
                // Difference is 315964800 seconds.
                const startTime = (startTimeGPS + 315964800) * 1000;
                const endTime = startTime + duration * 1000;

                let title = '';
                let description = '';
                let currentEventOffset = offset + 10; // After title_length

                // Parse title (Multi-String Structure)
                if (titleLength > 0 && currentEventOffset + titleLength <= section.length) {
                    // For simplicity, we'll extract the first string from the MSS.
                    // MSS format: num_strings (1 byte), then for each string: ISO_639_language_code (3 bytes), number_of_bytes_in_string (1 byte), string_text (variable)
                    let titleBuffer = section.slice(currentEventOffset, currentEventOffset + titleLength);
                    if (titleBuffer.length > 0) {
                        const numStrings = titleBuffer[0];
                        let stringOffset = 1;
                        if (numStrings > 0 && titleBuffer.length >= stringOffset + 4) { // At least one string header (lang + len)
                            // const langCode = titleBuffer.slice(stringOffset, stringOffset + 3).toString('ascii');
                            const stringLen = titleBuffer[stringOffset + 3];
                            if (titleBuffer.length >= stringOffset + 4 + stringLen) {
                                title = titleBuffer.slice(stringOffset + 4, stringOffset + 4 + stringLen).toString('utf8').trim();
                            }
                        }
                    }
                }
                currentEventOffset += titleLength;

                // Descriptors loop (for ETM or other event descriptors)
                // The ATSC EIT event structure has a 16-bit descriptors_length field after the title_text.
                // The provided snippet has `descLength` which seems to be for ETM.
                // Let's assume for now that `descLength` in the snippet refers to the total length of event descriptors.
                // The actual ATSC EIT structure has `descriptors_length` (16 bits) after `title_text`.
                // For simplicity, we'll skip parsing full descriptors for now and just advance the offset.
                // If ETM is present, it's usually indicated by ETM_location bits and then an ETM_id.
                // The provided snippet's `descLength` calculation is not standard ATSC EIT.
                // Let's use the standard `descriptors_length` field.

                // After title_length, there's a 16-bit descriptors_length
                if (currentEventOffset + 2 <= section.length) {
                    const descriptorsLength = ((section[currentEventOffset] & 0x0F) << 8) | section[currentEventOffset + 1]; // First 4 bits reserved
                    currentEventOffset += 2; // Move past descriptors_length field
                    if (currentEventOffset + descriptorsLength <= section.length) {
                        // Here you would parse descriptors for description if needed.
                        // For now, we just advance the offset.
                        currentEventOffset += descriptorsLength;
                    } else {
                        console.warn(`[ATSC EPG] Descriptors length ${descriptorsLength} exceeds section boundary at offset ${currentEventOffset}. Skipping descriptors.`);
                        currentEventOffset = section.length; // Advance to end of section to prevent out-of-bounds
                    }
                } else {
                    console.warn(`[ATSC EPG] Not enough bytes for descriptors_length field at offset ${currentEventOffset}.`);
                }
                if (title && startTime > 0) {
                    onFound();
                    console.log(`[ATSC EPG] INSERTING: "${title}" for Source ID: ${sourceId} (Starts: ${new Date(startTime).toISOString()})`);
                    db.run("INSERT OR IGNORE INTO programs (channel_service_id, start_time, end_time, title, description) VALUES (?, ?, ?, ?, ?)",
                        [serviceId.toString(), startTime, endTime, title, description]);
                } else {
                    console.log(`[EPG Verbose] Skipped event. Title: "${title}", Start: ${startTime}`);
                }

                offset = currentEventOffset; // Move to the start of the next event
            }
        } catch (e) {
            console.error('[ATSC EPG] Error:', e);
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
                    console.log(`[DVB EPG] Parsed: "${title}" for Service ID: ${serviceId}`);
                    db.run("INSERT OR IGNORE INTO programs (channel_service_id, start_time, end_time, title, description) VALUES (?, ?, ?, ?, ?)",
                        [serviceId.toString(), startTime, endTime, title, desc]);
                }

                evOffset += 12 + descriptorsLength;
            }
        } catch (e) {
            console.error('[DVB EPG] Error:', e);
        }
    }
};

// Schedule EPG grab every 15 minutes
setInterval(() => EPG.grab(), 15 * 60 * 1000);
// Priority: Initial grab on startup
EPG.grab();

// Generate M3U Playlist
app.get('/lineup.m3u', (req, res) => {
    let m3u = '#EXTM3U\n';
    const host = req.headers.host;

    CHANNELS.forEach(channel => {
        m3u += `#EXTINF:-1 tvg-id="${channel.number}" tvg-name="${channel.name}",${channel.number} ${channel.name}\n`;
        m3u += `http://${host}/stream/${channel.number}\n`;
    });

    res.set('Content-Type', 'audio/x-mpegurl');
    res.send(m3u);
});

// XMLTV Endpoint
app.get('/xmltv.xml', (req, res) => {
    db.all("SELECT * FROM programs WHERE end_time > ?", [Date.now()], (err, rows) => {
        if (err) return res.status(500).send(err.message);

        let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
        xml += '<tv>\n';

        // Channels
        CHANNELS.forEach(c => {
            xml += `  <channel id="${c.number}">\n`;
            xml += `    <display-name>${c.name}</display-name>\n`;
            xml += '  </channel>\n';
        });

        // Programs
        rows.forEach(p => {
            // Find channel number by service id
            const channel = CHANNELS.find(c => c.serviceId === p.channel_service_id);
            if (!channel) return;

            const start = new Date(p.start_time).toISOString().replace(/[-:]/g, '').split('.')[0] + ' +0000';
            const end = new Date(p.end_time).toISOString().replace(/[-:]/g, '').split('.')[0] + ' +0000';

            xml += `  <programme start="${start}" stop="${end}" channel="${channel.number}">\n`;
            xml += `    <title lang="en">${p.title}</title>\n`;
            xml += `    <desc lang="en">${p.description}</desc>\n`;
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
        channel.name
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

    console.log(`Spawning FFmpeg with args: ${ffmpegArgs.join(' ')}`);
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
        console.log(`FFmpeg exited [Tuner ${tuner.id}] with code ${code}`);
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
