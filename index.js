const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');

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

            if (serviceIdLine && vChannelLine) {
                const serviceId = serviceIdLine.split('=')[1].trim();
                const vChannel = vChannelLine.split('=')[1].trim();

                CHANNELS.push({
                    number: vChannel,
                    name: name,
                    serviceId: serviceId
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
    // 1. Try to find a free tuner
    let tuner = TUNERS.find(t => !t.inUse);
    if (tuner) return tuner;

    // 2. If all busy, try to preempt one (LIFO/FIFO policy? Just pick the first for now)
    // We prefer a tuner that is not 'cleaningUp' (i.e. currently streaming).
    if (ENABLE_PREEMPTION) {
        tuner = TUNERS.find(t => !t.cleaningUp);

        if (tuner) {
            console.log(`Preempting Tuner ${tuner.id} for new request...`);
            if (tuner.killSwitch) {
                tuner.killSwitch(); // Trigger cleanup of the active stream
            }
            // Wait for it to become free (max 3s)
            for (let i = 0; i < 15; i++) {
                if (!tuner.inUse) return tuner;
                await delay(200);
            }
            console.warn(`Tuner ${tuner.id} failed to release after preemption.`);
        }
    }

    // 3. Last ditch: wait for any tuner
    for (let i = 0; i < 10; i++) {
        tuner = TUNERS.find(t => !t.inUse);
        if (tuner) return tuner;
        await delay(500);
    }

    return null;
}

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

    // Base Args
    const ffmpegArgs = [
        '-fflags', '+genpts+discardcorrupt',
        '-err_detect', 'ignore_err',
        '-analyzeduration', '2000000',
        '-probesize', '2000000',
        '-i', 'pipe:0'
    ];

    if (ENABLE_TRANSCODING) {
        if (ENABLE_QSV) {
            // Hardware Transcoding (Intel QSV)
            // MUST deinterlace first as QSV often fails on interlaced input
            // -init_hw_device qsv=hw -filter_hw_device hw 
            // -vf "vpp_qsv=deinterlace=2" (Advanced deinterlacing) or "deinterlace_qsv"
            // For safety/portability, we'll try standard deinterlace_qsv

            // Note: input is pipe:0, so we need to map hw device first usually,
            // but for simple cases just specifying codec works if VAAPI/QSV is set up.
            // We adding global args for hw init might be redundant depending on ffmpeg build,
            // but let's stick to standard encoding params.

            ffmpegArgs.push(
                '-init_hw_device', 'qsv=hw',
                '-filter_hw_device', 'hw',
                '-c:v', 'h264_qsv',
                // Deinterlace using QSV VPP (Video Post Processing)
                '-vf', 'vpp_qsv=deinterlace=2',
                '-preset', 'veryfast', // QSV presets: veryfast, faster, fast, medium, slow, veryslow
                '-b:v', '5M',
                '-maxrate', '6M',
                '-bufsize', '12M',
                '-c:a', 'aac',
                '-b:a', '128k',
                '-ac', '2'
            );
        } else {
            // Software Transcoding (H.264/AAC)
            // ... existing software logic ...
            // We can use yadif for deinterlacing in software too, usually good idea for TV
            ffmpegArgs.push(
                '-c:v', 'libx264',
                '-preset', 'ultrafast',
                '-tune', 'zerolatency',
                '-vf', 'yadif=0:-1:0', // Simple deinterlace (send frame for each field)
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
    tuner.lastActivity = Date.now();
    tuner.watchdogInterval = setInterval(() => {
        const inactivity = Date.now() - tuner.lastActivity;
        if (inactivity > 30000) { // 30s timeout
            console.warn(`[Tuner ${tuner.id}] Watchdog: Client stalled for ${Math.round(inactivity / 1000)}s - releasing.`);
            // STOP THE WATCHDOG IMMEDIATELY to prevent spam
            clearInterval(tuner.watchdogInterval);
            tuner.watchdogInterval = null;
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
    // ffmpeg.stderr.on('data', (data) => console.log(`FFmpeg [Tuner ${tuner.id}]: ${data}`));
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

        // Kill processes
        if (tuner.processes.zap) tuner.processes.zap.kill('SIGTERM');
        if (tuner.processes.ffmpeg) tuner.processes.ffmpeg.kill('SIGTERM');

        // Safety timeout to force release if processes hang
        const forceReleaseTimeout = setTimeout(() => {
            console.warn(`Force releasing Tuner ${tuner.id} after timeout`);
            if (tuner.processes.zap) try { tuner.processes.zap.kill('SIGKILL'); } catch (e) { }
            if (tuner.processes.ffmpeg) try { tuner.processes.ffmpeg.kill('SIGKILL'); } catch (e) { }
        }, 2000);

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
