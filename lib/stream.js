const { spawn } = require('child_process');
const { acquireTuner } = require('./tuner');
const Channels = require('./channels');
const { CHANNELS_CONF, TRANSCODE_MODE, TRANSCODE_CODEC, VERBOSE_LOGGING } = require('./config');
const { debugLog, delay } = require('./utils');
const EPG = require('./epg');

async function handleStream(req, res) {
    if (!EPG.isInitialScanDone) {
        while (!EPG.isInitialScanDone) await delay(2000);
    }

    const channelNum = req.params.channelNum;
    const channel = Channels.CHANNELS.find(c => c.number === channelNum);
    if (!channel) return res.status(404).send('Channel not found');

    const tuner = await acquireTuner('live');
    if (!tuner) return res.status(503).send('No tuners available');

    // Parse parameters
    let codec = req.params.codec || req.query.c || TRANSCODE_CODEC;
    let format = req.params.format || req.query.f || '';

    codec = codec.toLowerCase();
    format = format.toLowerCase();

    // Map common aliases
    if (codec === '264') codec = 'h264';
    if (codec === '265') codec = 'h265';
    if (codec === 'hevc') codec = 'h265';

    // Auto-container logic
    if (!format) {
        if (codec === 'av1') format = 'mkv';
        else format = 'ts';
    }

    let container = 'mpegts';
    let contentType = 'video/mp2t';
    if (format === 'mkv' || format === 'matroska') {
        container = 'matroska';
        contentType = 'video/x-matroska';
    } else if (format === 'mp4') {
        container = 'mp4';
        contentType = 'video/mp4';
    }

    // Determine H/W or S/W Engine
    let engine = TRANSCODE_MODE.toLowerCase();
    if (codec !== 'copy' && engine === 'none') engine = 'soft';

    console.log(`[Stream] Tuner ${tuner.id} | ${channel.name} | Engine: ${engine} | Codec: ${codec} | Format: ${container}`);

    tuner.inUse = true;
    tuner.processes = {};
    tuner.lastActivity = Date.now();
    await delay(1000);

    const zap = spawn('dvbv5-zap', ['-c', CHANNELS_CONF, '-r', '-a', tuner.id, '-o', '-', channel.number]);
    tuner.processes.zap = zap;

    const cleanup = () => {
        if (tuner.cleaningUp) return;
        tuner.cleaningUp = true;
        if (tuner.watchdogInterval) clearInterval(tuner.watchdogInterval);
        const procs = tuner.processes || {};
        if (procs.ffmpeg) try { procs.ffmpeg.kill('SIGTERM'); } catch (e) { }
        if (procs.zap) try { procs.zap.kill('SIGTERM'); } catch (e) { }
        setTimeout(() => {
            if (procs.ffmpeg) try { procs.ffmpeg.kill('SIGKILL'); } catch (e) { }
            if (procs.zap) try { procs.zap.kill('SIGKILL'); } catch (e) { }
            tuner.inUse = false;
            tuner.usageType = null;
            tuner.cleaningUp = false;
        }, 2000);
    };
    tuner.killSwitch = cleanup;

    const ffmpegArgs = [];
    if (engine === 'qsv') ffmpegArgs.push('-init_hw_device', 'qsv=hw', '-filter_hw_device', 'hw');
    else if (engine === 'vaapi') ffmpegArgs.push('-init_hw_device', 'vaapi=gpu:/dev/dri/renderD128', '-filter_hw_device', 'gpu');

    ffmpegArgs.push('-fflags', '+genpts+discardcorrupt', '-err_detect', 'ignore_err', '-analyzeduration', '2000000', '-probesize', '2000000', '-i', 'pipe:0');

    if (codec === 'copy') {
        ffmpegArgs.push('-c', 'copy');
    } else {
        if (engine === 'nvenc') {
            let vEncoder = 'h264_nvenc';
            if (codec === 'h265') vEncoder = 'hevc_nvenc';
            else if (codec === 'av1') vEncoder = 'av1_nvenc';
            ffmpegArgs.push('-vf', 'format=nv12', '-c:v', vEncoder, '-preset', 'p1', '-tune', 'hq', '-rc', 'vbr', '-cq', '23', '-b:v', '5M', '-maxrate', '6M', '-bufsize', '12M');
        } else if (engine === 'soft' || engine === 'software') {
            if (codec === 'h265') ffmpegArgs.push('-c:v', 'libx265', '-preset', 'ultrafast', '-tune', 'zerolatency');
            else if (codec === 'av1') ffmpegArgs.push('-c:v', 'libsvtav1', '-preset', '10');
            else ffmpegArgs.push('-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency');
            ffmpegArgs.push('-crf', '23', '-maxrate', '5M', '-bufsize', '10M');
        } else if (engine === 'qsv') {
            let vEncoder = 'h264_qsv';
            if (codec === 'h265') vEncoder = 'hevc_qsv';
            else if (codec === 'av1') vEncoder = 'av1_qsv';
            ffmpegArgs.push('-vf', 'yadif=0:-1:0,format=nv12,hwupload=extra_hw_frames=64,format=qsv', '-c:v', vEncoder, '-preset', 'veryfast', '-global_quality', '23', '-b:v', '5M', '-maxrate', '6M', '-bufsize', '12M');
        } else if (engine === 'vaapi') {
            let vEncoder = 'h264_vaapi';
            if (codec === 'h265') vEncoder = 'hevc_vaapi';
            else if (codec === 'av1') vEncoder = 'av1_vaapi';
            ffmpegArgs.push('-vf', 'format=nv12,hwupload', '-c:v', vEncoder, '-flags', '-global_header', '-sei', '-all', '-b:v', '5M', '-maxrate', '6M', '-bufsize', '10M');
        }
        ffmpegArgs.push('-c:a', 'aac', '-b:a', '128k', '-ac', '2');
    }

    if (container === 'mp4') {
        ffmpegArgs.push('-movflags', 'frag_keyframe+empty_moov+default_base_moof');
    }
    ffmpegArgs.push('-f', container, 'pipe:1');

    const ffmpeg = spawn('ffmpeg', ffmpegArgs);
    tuner.processes.ffmpeg = ffmpeg;

    let ffmpegScrollback = [];
    ffmpeg.stderr.on('data', d => {
        const line = d.toString();
        ffmpegScrollback.push(line);
        if (ffmpegScrollback.length > 10) ffmpegScrollback.shift();
        if (VERBOSE_LOGGING) console.log(`FFmpeg [Tuner ${tuner.id}]: ${line}`);
    });

    zap.stdout.pipe(ffmpeg.stdin).on('error', err => {
        if (err.code === 'EPIPE') {
            console.warn(`[Tuner ${tuner.id}] Early exit. Scrollback:`);
            ffmpegScrollback.forEach(l => console.warn(`  > ${l.trim()}`));
        }
        cleanup();
    });

    res.writeHead(200, { 'Content-Type': contentType, 'Connection': 'keep-alive' });

    tuner.watchdogInterval = setInterval(() => {
        if (Date.now() - tuner.lastActivity > 30000) cleanup();
    }, 5000);

    ffmpeg.stdout.on('data', () => { tuner.lastActivity = Date.now(); });
    ffmpeg.stdout.pipe(res).on('error', cleanup);

    const onEnd = () => cleanup();
    req.on('close', onEnd);
    res.on('close', onEnd);
}

module.exports = { handleStream };
