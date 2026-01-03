const { spawn } = require('child_process');
const { acquireTuner } = require('./tuner');
const Channels = require('./channels');
const { CHANNELS_CONF, TRANSCODE_MODE, VERBOSE_LOGGING } = require('./config');
const { debugLog, delay } = require('./utils');
const EPG = require('./epg');

async function handleStream(req, res) {
    // Wait for EPG if it's the initial scan (startup)
    if (!EPG.isInitialScanDone) {
        console.log(`[Stream] Waiting for initial EPG scan to finish for ${req.params.channelNum}... (it may take a few minutes)`);
        while (!EPG.isInitialScanDone) {
            await delay(2000);
        }
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

    // Reset tuner state for new session
    tuner.inUse = true;
    tuner.cleaningUp = false;
    tuner.processes = {};
    tuner.lastActivity = Date.now();

    // Give hardware a moment to settle if it was just released
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
        if (tuner.cleaningUp) return;
        tuner.cleaningUp = true;

        if (tuner.watchdogInterval) {
            clearInterval(tuner.watchdogInterval);
            tuner.watchdogInterval = null;
        }

        console.log(`Cleaning up Tuner ${tuner.id}...`);
        tuner.killSwitch = null;

        // Graceful kill sequence
        const procs = tuner.processes || {};

        if (procs.ffmpeg) {
            try { procs.ffmpeg.kill('SIGTERM'); } catch (e) { }
        }
        if (procs.zap) {
            try { procs.zap.kill('SIGTERM'); } catch (e) { }
        }

        // Force kill after 2 seconds if still running
        const killTimeout = setTimeout(() => {
            if (procs.ffmpeg) try { procs.ffmpeg.kill('SIGKILL'); } catch (e) { }
            if (procs.zap) try { procs.zap.kill('SIGKILL'); } catch (e) { }

            console.warn(`Force released Tuner ${tuner.id} state (cleanup timeout)`);
            tuner.inUse = false;
            tuner.cleaningUp = false;
            tuner.processes = {};
        }, 2000);

        tuner.forceReleaseTimeout = killTimeout;
    };

    tuner.killSwitch = cleanup;

    zap.on('error', (err) => {
        console.error(`Tuner ${tuner.id} zap error:`, err);
        cleanup();
        if (!res.headersSent) res.status(500).send('Tuner error');
    });

    const ffmpegArgs = [];

    // Determine Transcoding Strategy
    let strategy = TRANSCODE_MODE.toLowerCase();

    if (strategy === 'qsv') {
        ffmpegArgs.push('-init_hw_device', 'qsv=hw', '-filter_hw_device', 'hw');
    } else if (strategy === 'vaapi') {
        ffmpegArgs.push('-init_hw_device', 'vaapi=gpu:/dev/dri/renderD128', '-filter_hw_device', 'gpu');
    }

    ffmpegArgs.push(
        '-fflags', '+genpts+discardcorrupt',
        '-err_detect', 'ignore_err',
        '-analyzeduration', '2000000',
        '-probesize', '2000000',
        '-i', 'pipe:0'
    );

    if (strategy === 'nvenc') {
        ffmpegArgs.push(
            '-vf', 'format=nv12',
            '-c:v', 'h264_nvenc',
            '-preset', 'p1',
            '-tune', 'hq',
            '-rc', 'vbr',
            '-cq', '23',
            '-b:v', '5M',
            '-maxrate', '6M',
            '-bufsize', '12M',
            '-c:a', 'aac', '-b:a', '128k', '-ac', '2'
        );
    } else if (strategy === 'soft' || strategy === 'software') {
        ffmpegArgs.push(
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-tune', 'zerolatency',
            '-crf', '23',
            '-maxrate', '5M',
            '-bufsize', '10M',
            '-c:a', 'aac', '-b:a', '128k', '-ac', '2'
        );
    } else if (strategy === 'qsv') {
        ffmpegArgs.push(
            '-vf', 'yadif=0:-1:0,format=nv12,hwupload=extra_hw_frames=64,format=qsv',
            '-c:v', 'h264_qsv',
            '-preset', 'veryfast',
            '-global_quality', '23',
            '-b:v', '5M',
            '-maxrate', '6M',
            '-bufsize', '12M',
            '-c:a', 'aac', '-b:a', '128k', '-ac', '2'
        );
    } else if (strategy === 'vaapi') {
        ffmpegArgs.push(
            '-vf', 'format=nv12,hwupload',
            '-c:v', 'h264_vaapi',
            '-flags', '-global_header',
            '-sei', '-all',
            '-b:v', '5M',
            '-maxrate', '6M',
            '-bufsize', '10M',
            '-c:a', 'aac', '-b:a', '128k', '-ac', '2'
        );
    } else {
        ffmpegArgs.push('-c', 'copy');
    }

    ffmpegArgs.push('-f', 'mpegts', 'pipe:1');

    debugLog(`Spawning FFmpeg with args: ${ffmpegArgs.join(' ')}`);
    const ffmpeg = spawn('ffmpeg', ffmpegArgs);
    tuner.processes.ffmpeg = ffmpeg;

    // Buffer to capture last few errors from ffmpeg
    let ffmpegScrollback = [];
    ffmpeg.stderr.on('data', (data) => {
        const line = data.toString();
        ffmpegScrollback.push(line);
        if (ffmpegScrollback.length > 10) ffmpegScrollback.shift();
        if (VERBOSE_LOGGING) console.log(`FFmpeg [Tuner ${tuner.id}]: ${line}`);
    });

    zap.stderr.on('data', (data) => {
        if (VERBOSE_LOGGING) console.log(`Zap [Tuner ${tuner.id}]: ${data}`);
    });

    ffmpeg.stdin.on('error', (err) => {
        if (err.code !== 'EPIPE') {
            console.error(`FFmpeg stdin error [Tuner ${tuner.id}]:`, err);
        }
    });

    zap.stdout.pipe(ffmpeg.stdin).on('error', (err) => {
        if (err.code === 'EPIPE') {
            console.warn(`[Tuner ${tuner.id}] FFmpeg closed pipe (EPIPE) early. Last FFmpeg output:`);
            ffmpegScrollback.forEach(l => console.warn(`  > ${l.trim()}`));
        } else {
            console.warn(`Zap stdout pipe error [Tuner ${tuner.id}]:`, err);
        }
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

    tuner.watchdogInterval = setInterval(() => {
        if (tuner.cleaningUp) return;
        const inactivity = Date.now() - tuner.lastActivity;
        if (inactivity > 30000) {
            console.warn(`[Tuner ${tuner.id}] Watchdog: Client stalled for ${Math.round(inactivity / 1000)}s - releasing.`);
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

    zap.on('exit', (code, signal) => {
        console.log(`Zap exited [Tuner ${tuner.id}] (code: ${code}, signal: ${signal})`);
        if (tuner.processes.ffmpeg) {
            try { tuner.processes.ffmpeg.kill('SIGTERM'); } catch (e) { }
        }

        // Final state release
        setTimeout(() => {
            if (tuner.forceReleaseTimeout) {
                clearTimeout(tuner.forceReleaseTimeout);
                tuner.forceReleaseTimeout = null;
            }
            tuner.inUse = false;
            tuner.cleaningUp = false;
            tuner.processes = {};
            console.log(`Tuner ${tuner.id} marked as FREE`);
        }, 500);
    });

    ffmpeg.on('exit', (code) => {
        if (code !== 0 && code !== null) {
            console.error(`FFmpeg exited with ERROR code ${code} [Tuner ${tuner.id}]. Last output:`);
            ffmpegScrollback.forEach(l => console.error(`  > ${l.trim()}`));
        } else {
            debugLog(`FFmpeg exited [Tuner ${tuner.id}] with code ${code}`);
        }
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
