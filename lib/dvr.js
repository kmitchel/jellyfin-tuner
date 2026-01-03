const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { db } = require('./db');
const { RECORDINGS_DIR, CHANNELS_CONF, TRANSCODE_MODE, TRANSCODE_CODEC, VERBOSE_LOGGING } = require('./config');
const { acquireTuner } = require('./tuner');
const Channels = require('./channels');
const { delay } = require('./utils');

const ACTIVE_RECORDINGS = new Map(); // id -> process details

const DVR = {
    init() {
        if (!fs.existsSync(RECORDINGS_DIR)) {
            fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
        }
        setInterval(() => this.checkTimers(), 30000); // Check every 30s
    },

    async checkTimers() {
        const now = Date.now();

        // 1. One-time timers
        db.all("SELECT * FROM timers WHERE type = 'once' AND start_time <= ? AND end_time > ?", [now, now], (err, ones) => {
            if (err) return console.error('[DVR] Error loading once timers:', err);
            ones.forEach(t => this.maybeStartRecording(t, t.title));
        });

        // 2. Series timers (match by title in EPG)
        db.all("SELECT * FROM timers WHERE type = 'series'", (err, series) => {
            if (err) return console.error('[DVR] Error loading series timers:', err);
            series.forEach(timer => {
                db.all("SELECT * FROM programs WHERE title = ? AND start_time <= ? AND end_time > ?", [timer.title, now, now], (err, progs) => {
                    if (err) return;
                    progs.forEach(p => {
                        // Check if we are already recording this specific program instance (start_time + channel)
                        const key = `${p.title}_${p.start_time}`;
                        this.maybeStartRecording(timer, p.title, p);
                    });
                });
            });
        });

        // 3. Stop ended recordings
        for (const [id, rec] of ACTIVE_RECORDINGS.entries()) {
            if (now >= rec.endTime + 5000) { // 5s grace
                this.stopRecording(id);
            }
        }
    },

    async maybeStartRecording(timer, title, program = null) {
        const now = Date.now();
        const startTime = program ? program.start_time : timer.start_time;
        const endTime = program ? program.end_time : timer.end_time;
        const channelNum = program ? program.channel_service_id : timer.channel_num;

        // Find which channel object this is
        const channel = Channels.CHANNELS.find(c => c.number === channelNum);
        if (!channel) return;

        const recKey = `${channelNum}_${startTime}`;
        if (ACTIVE_RECORDINGS.has(recKey)) return;

        // Check if already in database as recording/completed
        db.get("SELECT id FROM recordings WHERE channel_num = ? AND start_time = ?", [channelNum, startTime], async (err, row) => {
            if (row) return; // Already exists

            console.log(`[DVR] Starting recording: ${title} on ${channel.name}...`);
            const tuner = await acquireTuner('dvr');
            if (!tuner) {
                console.warn(`[DVR] No tuners available for recording: ${title}`);
                return;
            }

            const safeTitle = title.replace(/[^a-z0-9]/gi, '_').toLowerCase();
            const filename = `${safeTitle}_${startTime}.mkv`;
            const filePath = path.join(RECORDINGS_DIR, filename);

            // Insert into DB
            db.run(`INSERT INTO recordings (title, description, channel_name, channel_num, start_time, end_time, file_path, status, timer_id) 
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [title, program ? program.description : '', channel.name, channelNum, startTime, endTime, filePath, 'recording', timer.id],
                function (err) {
                    if (err) {
                        tuner.inUse = false;
                        tuner.usageType = null;
                        return console.error('[DVR] Failed to log recording:', err);
                    }
                    const recId = this.lastID;
                    DVR.startProcess(recId, recKey, tuner, channel, filePath, endTime);
                }
            );
        });
    },

    async startProcess(recId, recKey, tuner, channel, filePath, endTime) {
        tuner.inUse = true;
        tuner.processes = {};

        const zap = spawn('dvbv5-zap', ['-c', CHANNELS_CONF, '-r', '-a', tuner.id, '-o', '-', channel.number]);
        tuner.processes.zap = zap;

        // Determine FFmpeg settings (High Quality Matroska)
        let codec = (TRANSCODE_CODEC === 'copy') ? 'copy' : TRANSCODE_CODEC;
        let engine = TRANSCODE_MODE.toLowerCase();
        if (codec !== 'copy' && engine === 'none') engine = 'soft';

        const ffmpegArgs = [];
        if (engine === 'qsv') ffmpegArgs.push('-init_hw_device', 'qsv=hw', '-filter_hw_device', 'hw');
        else if (engine === 'vaapi') ffmpegArgs.push('-init_hw_device', 'vaapi=gpu:/dev/dri/renderD128', '-filter_hw_device', 'gpu');

        ffmpegArgs.push('-i', 'pipe:0');

        if (codec === 'copy') {
            ffmpegArgs.push('-c', 'copy');
        } else {
            if (engine === 'nvenc') {
                let vEnc = (codec === 'h265') ? 'hevc_nvenc' : (codec === 'av1' ? 'av1_nvenc' : 'h264_nvenc');
                ffmpegArgs.push('-c:v', vEnc, '-preset', 'p4', '-rc', 'vbr', '-cq', '18', '-b:v', '10M', '-maxrate', '15M');
            } else if (engine === 'soft') {
                let vEnc = (codec === 'h265') ? 'libx265' : (codec === 'av1' ? 'libsvtav1' : 'libx264');
                ffmpegArgs.push('-c:v', vEnc, '-preset', 'fast', '-crf', '18');
            } else if (engine === 'qsv') {
                let vEnc = (codec === 'h265') ? 'hevc_qsv' : (codec === 'av1' ? 'av1_qsv' : 'h264_qsv');
                ffmpegArgs.push('-vf', 'yadif=0:-1:0,format=nv12,hwupload=extra_hw_frames=64,format=qsv', '-c:v', vEnc, '-preset', 'medium', '-global_quality', '20');
            } else if (engine === 'vaapi') {
                let vEnc = (codec === 'h265') ? 'hevc_vaapi' : (codec === 'av1' ? 'av1_vaapi' : 'h264_vaapi');
                ffmpegArgs.push('-vf', 'format=nv12,hwupload', '-c:v', vEnc, '-qp', '18');
            }
            ffmpegArgs.push('-c:a', 'aac', '-b:a', '192k');
        }

        ffmpegArgs.push('-f', 'matroska', filePath);

        zap.on('error', (err) => {
            console.error(`[DVR] Failed to start Zap process: ${err.message}`);
            tuner.inUse = false;
            tuner.usageType = null;
        });

        zap.on('exit', (code) => {
            if (code !== 0 && code !== null) {
                console.error(`[DVR] Zap process for Recording ${recId} exited with error code ${code}`);
            }
        });

        const ffmpeg = spawn('ffmpeg', ['-y', '-analyzeduration', '5000000', '-probesize', '5000000', ...ffmpegArgs]);
        tuner.processes.ffmpeg = ffmpeg;

        ffmpeg.on('error', (err) => {
            console.error(`[DVR] Failed to start FFmpeg process: ${err.message}`);
            tuner.inUse = false;
            tuner.usageType = null;
            zap.kill('SIGKILL');
        });

        zap.stdout.pipe(ffmpeg.stdin);

        zap.stderr.on('data', d => {
            const msg = d.toString().trim();
            if (msg.includes('error') || msg.includes('fail')) console.error(`[DVR Debug] Zap Error: ${msg}`);
        });

        ffmpeg.stderr.on('data', d => {
            const msg = d.toString().trim();
            if (VERBOSE_LOGGING || msg.includes('Error')) console.log(`[DVR Debug] FFmpeg Stderr: ${msg}`);
        });

        ACTIVE_RECORDINGS.set(recKey, {
            recId,
            tuner,
            endTime,
            filePath
        });

        ffmpeg.on('exit', (code) => {
            console.log(`[DVR] FFmpeg for Recording ${recId} exited with code ${code}`);
            db.run("UPDATE recordings SET status = ? WHERE id = ?", [code === 0 ? 'completed' : 'failed', recId]);
            tuner.inUse = false;
            tuner.usageType = null;
            ACTIVE_RECORDINGS.delete(recKey);
        });
    },

    stopRecording(recKey) {
        const rec = ACTIVE_RECORDINGS.get(recKey);
        if (!rec) return;
        console.log(`[DVR] Stopping recording ${rec.recId}...`);
        if (rec.tuner.processes.ffmpeg) rec.tuner.processes.ffmpeg.kill('SIGTERM');
        if (rec.tuner.processes.zap) rec.tuner.processes.zap.kill('SIGTERM');
    }
};

module.exports = DVR;
