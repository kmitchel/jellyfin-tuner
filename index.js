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
                const serviceId = serviceIdLine.split('=')[1].trim();
                const vChannel = vChannelLine.split('=')[1].trim();
                const frequency = freqLine ? freqLine.split('=')[1].trim() : null;

                CHANNELS.push({
                    number: vChannel,
                    name: name,
                    serviceId: serviceId,
                    frequency: frequency
                });
            }
        });

        console.log(`Loaded ${CHANNELS.length} channels.`);

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
            console.log('[EPG] Waiting for all tuners to be free to start scan...');
            return;
        }

        this.isScanning = true;
        console.log('[EPG] Starting background EPG scan...');

        const muxMap = new Map();
        CHANNELS.forEach(c => {
            if (c.frequency) {
                if (!muxMap.has(c.frequency)) muxMap.set(c.frequency, c.name);
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
                await this.scanMux(tuner, channelName);
            } catch (e) {
                console.error(`[EPG] Error scanning mux at ${freq}:`, e);
            }

            tuner.inUse = false;
            tuner.epgScanning = false;

            // Short delay between muxes
            await delay(2000);
        }

        this.isScanning = false;
        this.lastScan = Date.now();
        console.log('[EPG] Background EPG scan complete.');
    },

    scanMux(tuner, channelName) {
        return new Promise((resolve) => {
            const zap = spawn('dvbv5-zap', [
                '-c', CHANNELS_CONF,
                '-r',
                '-a', tuner.id,
                '-P', '18', // Only EIT PID
                '-o', '-',
                channelName
            ]);

            let buffer = Buffer.alloc(0);

            zap.stdout.on('data', (data) => {
                buffer = Buffer.concat([buffer, data]);
                if (buffer.length > 15 * 1024 * 1024) { // 15MB buffer
                    zap.kill('SIGKILL');
                }
            });

            const timeout = setTimeout(() => zap.kill('SIGKILL'), 90000); // 90s per mux (broadcast EPG can be slow)

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
        // Minimal TS/EIT Parser
        for (let i = 0; i < buffer.length - 188; i += 188) {
            if (buffer[i] !== 0x47) {
                // Not sync, search next
                let next = buffer.indexOf(0x47, i);
                if (next === -1) break;
                i = next;
            }

            const pid = ((buffer[i + 1] & 0x1F) << 8) | buffer[i + 2];
            if (pid !== 18) continue;

            const pusi = buffer[i + 1] & 0x40;
            const adaptation = (buffer[i + 3] & 0x30) >> 4;
            let offset = 4;
            if (adaptation === 2 || adaptation === 3) offset += buffer[i + 4] + 1;
            if (pusi) offset += buffer[i + offset] + 1;

            const payload = buffer.slice(i + offset, i + 188);
            if (payload.length < 12) continue;

            const tableId = payload[0];
            if (tableId < 0x4E || tableId > 0x6F) continue; // EIT Table IDs

            const serviceId = (payload[3] << 8) | payload[4];

            // Loop through events
            let evOffset = 15; // Start of events loop
            const sectionLength = ((payload[1] & 0x0F) << 8) | payload[2];

            while (evOffset < sectionLength - 4) {
                const startTimeMJD = (payload[evOffset + 2] << 8) | payload[evOffset + 3];
                const startTimeBCD = (payload[evOffset + 4] << 16) | (payload[evOffset + 5] << 8) | payload[evOffset + 6];
                const durationBCD = (payload[evOffset + 7] << 16) | (payload[evOffset + 8] << 8) | payload[evOffset + 9];
                const descriptorsLength = ((payload[evOffset + 10] & 0x0F) << 8) | payload[evOffset + 11];

                const startTime = this.parseDVBTime(startTimeMJD, startTimeBCD);
                const durationSec = (((durationBCD >> 16) & 0xFF) >> 4) * 36000 + ((durationBCD >> 16) & 0x0F) * 3600 +
                    (((durationBCD >> 8) & 0xFF) >> 4) * 600 + ((durationBCD >> 8) & 0x0F) * 60 +
                    ((durationBCD & 0xFF) >> 4) * 10 + (durationBCD & 0x0F);

                const endTime = startTime + durationSec * 1000;

                // Parse descriptors for title
                let descOffset = evOffset + 12;
                let title = '';
                let desc = '';

                while (descOffset < evOffset + 12 + descriptorsLength) {
                    const tag = payload[descOffset];
                    const len = payload[descOffset + 1];
                    if (tag === 0x4D) { // Short Event Descriptor
                        const titleLen = payload[descOffset + 3];
                        title = payload.slice(descOffset + 4, descOffset + 4 + titleLen).toString('utf8').replace(/[^\x20-\x7E]/g, '');
                        const descLen = payload[descOffset + 4 + titleLen];
                        desc = payload.slice(descOffset + 5 + titleLen, descOffset + 5 + titleLen + descLen).toString('utf8').replace(/[^\x20-\x7E]/g, '');
                    }
                    descOffset += 2 + len;
                }

                if (title && startTime > 0) {
                    programCount++;
                    db.run("INSERT OR IGNORE INTO programs (channel_service_id, start_time, end_time, title, description) VALUES (?, ?, ?, ?, ?)",
                        [serviceId.toString(), startTime, endTime, title, desc]);
                }

                evOffset += 12 + descriptorsLength;
            }
        }
        return programCount;
    }
};

// Schedule EPG grab every 15 minutes
setInterval(() => EPG.grab(), 15 * 60 * 1000);
// Also try once at startup after a delay
setTimeout(() => EPG.grab(), 30000);

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
