const { spawn } = require('child_process');
const { acquireTuner } = require('./tuner');
const Channels = require('./channels');
const { CHANNELS_CONF, ENABLE_TRANSCODING, ENABLE_QSV, VERBOSE_LOGGING } = require('./config');
const { debugLog, delay } = require('./utils');
const EPG = require('./epg');

async function handleStream(req, res) {
    if (!EPG.isInitialScanDone) {
        return res.status(503).send('Service Unavailable: Initial EPG scan in progress. Please wait a few minutes.');
    }

    const channelNum = req.params.channelNum;
    const channel = Channels.CHANNELS.find(c => c.number === channelNum);

    if (!channel) {
        return res.status(404).send('Channel not found');
    }

    const tuner = await acquireTuner();
    if (!tuner) {
        return res.status(503).send('No tuners available');
    }

    console.log(`Acquired Tuner ${tuner.id} for ${channel.name}`);
    console.log(`Starting stream for ${channel.name} on Tuner ${tuner.id}`);
    tuner.inUse = true;
    tuner.processes = {};

    await delay(1000);

    const zap = spawn('dvbv5-zap', [
        '-c', CHANNELS_CONF,
        '-r',
        '-a', tuner.id,
        '-o', '-',
        channel.number
    ]);
    tuner.processes.zap = zap;

    const cleanup = () => {
        if (tuner.watchdogInterval) {
            clearInterval(tuner.watchdogInterval);
            tuner.watchdogInterval = null;
        }

        if (tuner.cleaningUp) return;
        tuner.cleaningUp = true;

        console.log(`Cleaning up Tuner ${tuner.id}`);
        tuner.killSwitch = null;

        if (tuner.processes.zap) {
            try { tuner.processes.zap.kill('SIGKILL'); } catch (e) { }
        }
        if (tuner.processes.ffmpeg) {
            try { tuner.processes.ffmpeg.kill('SIGKILL'); } catch (e) { }
        }

        const forceReleaseTimeout = setTimeout(() => {
            console.warn(`Force releasing Tuner ${tuner.id} state (cleanup timeout)`);
            tuner.inUse = false;
            tuner.cleaningUp = false;
            tuner.processes = {};
        }, 1000);

        tuner.forceReleaseTimeout = forceReleaseTimeout;
    };

    tuner.killSwitch = cleanup;

    zap.on('error', (err) => {
        console.error(`Tuner ${tuner.id} zap error:`, err);
        cleanup();
        if (!res.headersSent) res.status(500).send('Tuner error');
    });

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
        ffmpegArgs.push('-c', 'copy');
    }

    ffmpegArgs.push('-f', 'mpegts', 'pipe:1');

    debugLog(`Spawning FFmpeg with args: ${ffmpegArgs.join(' ')}`);
    const ffmpeg = spawn('ffmpeg', ffmpegArgs);
    tuner.processes.ffmpeg = ffmpeg;

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

    if (tuner.watchdogInterval) clearInterval(tuner.watchdogInterval);
    tuner.lastActivity = Date.now();
    tuner.watchdogInterval = setInterval(() => {
        if (tuner.cleaningUp) return;
        const inactivity = Date.now() - tuner.lastActivity;
        if (inactivity > 30000) {
            console.warn(`[Tuner ${tuner.id}] Watchdog: Client stalled for ${Math.round(inactivity / 1000)}s - releasing.`);
            if (tuner.watchdogInterval) {
                clearInterval(tuner.watchdogInterval);
                tuner.watchdogInterval = null;
            }
            cleanup();
        }
    }, 5000);

    ffmpeg.stdout.on('data', () => {
        tuner.lastActivity = Date.now();
    });

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

    ffmpeg.stderr.on('data', (data) => console.log(`FFmpeg [Tuner ${tuner.id}]: ${data}`));
    zap.stderr.on('data', (data) => console.log(`Zap [Tuner ${tuner.id}]: ${data}`));

    zap.on('exit', (code, signal) => {
        console.log(`Zap exited [Tuner ${tuner.id}] (code: ${code}, signal: ${signal})`);
        if (tuner.forceReleaseTimeout) {
            clearTimeout(tuner.forceReleaseTimeout);
            tuner.forceReleaseTimeout = null;
        }
        tuner.inUse = false;
        tuner.cleaningUp = false;
        tuner.killSwitch = null;
        tuner.processes = {};
        console.log(`Tuner ${tuner.id} marked as FREE`);
    });

    ffmpeg.on('exit', (code) => {
        debugLog(`FFmpeg exited [Tuner ${tuner.id}] with code ${code}`);
        cleanup();
    });

    const onDisconnect = () => {
        console.log(`Client disconnected (socket close) [Tuner ${tuner.id}]`);
        cleanup();
    };
    req.on('close', onDisconnect);
    res.on('close', onDisconnect);
}

module.exports = { handleStream };
