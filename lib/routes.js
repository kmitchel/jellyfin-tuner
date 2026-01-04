const fs = require('fs');
const DVR = require('./dvr');
const Channels = require('./channels');
const { db } = require('./db');
const { escapeXml, formatXmltvDate } = require('./utils');
const { handleStream, handleFileStream } = require('./stream');
const { ENABLE_EPG } = require('./config');

function setupRoutes(app) {
    // Playlist Endpoint: /playlist.m3u?f=mkv&c=h265
    app.get('/playlist.m3u', (req, res) => {
        const host = req.get('host');
        const format = req.query.f || '';
        const codec = req.query.c || '';

        const params = new URLSearchParams();
        if (format) params.set('f', format);
        if (codec) params.set('c', codec);
        const queryString = params.toString() ? '?' + params.toString() : '';

        let m3u = '#EXTM3U\n';
        Channels.CHANNELS.forEach(channel => {
            let logoAttr = channel.icon ? ` tvg-logo="${channel.icon}"` : '';
            m3u += `#EXTINF:-1 tvg-id="${channel.number}" tvg-name="${channel.name}"${logoAttr},${channel.name}\n`;
            m3u += `http://${host}/stream/${channel.number}${queryString}\n`;
        });

        res.set('Content-Type', 'audio/x-mpegurl');
        res.send(m3u);
    });

    // XMLTV Endpoint
    app.get('/xmltv.xml', (req, res) => {
        const sendXml = (rows = []) => {
            let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
            xml += '<tv generator-info-name="Express M3U Tuner">\n';

            Channels.CHANNELS.forEach(c => {
                const icon = c.icon;
                xml += `  <channel id="${c.number}">\n`;
                xml += `    <display-name>${escapeXml(c.name)}</display-name>\n`;
                if (icon) xml += `    <icon src="${escapeXml(icon)}" />\n`;
                xml += '  </channel>\n';
            });

            rows.forEach(p => {
                const channel = Channels.CHANNELS.find(c => {
                    if (p.frequency) {
                        return c.frequency == p.frequency && (c.number == p.channel_service_id || c.serviceId == p.channel_service_id);
                    }
                    return c.serviceId == p.channel_service_id || c.number == p.channel_service_id;
                });

                if (!channel) return;

                xml += `  <programme start="${formatXmltvDate(p.start_time)}" stop="${formatXmltvDate(p.end_time)}" channel="${channel.number}">\n`;
                xml += `    <title lang="en">${escapeXml(p.title)}</title>\n`;
                if (p.description) xml += `    <desc lang="en">${escapeXml(p.description)}</desc>\n`;
                xml += '  </programme>\n';
            });

            xml += '</tv>';
            res.set('Content-Type', 'application/xml');
            res.send(xml);
        };

        if (!ENABLE_EPG) return sendXml();

        db.all("SELECT * FROM programs WHERE end_time > ? ORDER BY frequency, channel_service_id, start_time", [Date.now()], (err, rows) => {
            if (err) {
                console.error(err);
                return res.status(500).send(err.message);
            }
            sendXml(rows);
        });
    });

    // Stream Endpoint: /stream/5.1 or /stream/5.1/mkv or /stream/5.1/mkv/h265
    // Also supports query params: /stream/5.1?f=mkv&c=av1
    app.get(['/stream/:channelNum', '/stream/:channelNum/:format', '/stream/:channelNum/:format/:codec'], handleStream);

    // API: Now Playing
    app.get('/api/now-playing', (req, res) => {
        if (!ENABLE_EPG) {
            return res.json({ channels: Channels.CHANNELS.map(c => ({ ...c, now_playing: null })) });
        }

        const now = Date.now();
        db.all("SELECT * FROM programs WHERE start_time <= ? AND end_time > ?", [now, now], (err, rows) => {
            if (err) {
                console.error(err);
                return res.status(500).json({ error: err.message });
            }

            const results = Channels.CHANNELS.map(channel => {
                const program = rows.find(p => {
                    if (p.frequency) {
                        return channel.frequency == p.frequency && (channel.number == p.channel_service_id || channel.serviceId == p.channel_service_id);
                    }
                    return channel.serviceId == p.channel_service_id || channel.number == p.channel_service_id;
                });

                return {
                    ...channel,
                    now_playing: program ? {
                        title: program.title,
                        description: program.description,
                        start: program.start_time,
                        end: program.end_time,
                        progress: Math.round(((now - program.start_time) / (program.end_time - program.start_time)) * 100)
                    } : null
                };
            });

            res.json({ channels: results });
        });
    });

    // API: Guide (Channels + Programs for next 12h)
    app.get('/api/guide', (req, res) => {
        if (!ENABLE_EPG) {
            return res.json({ channels: Channels.CHANNELS.map(c => ({ ...c, programs: [] })) });
        }

        const start = Date.now() - (60 * 60 * 1000); // 1 hour ago
        const end = Date.now() + (12 * 60 * 60 * 1000); // 12 hours ahead

        db.all("SELECT * FROM programs WHERE end_time > ? AND start_time < ? ORDER BY start_time", [start, end], (err, rows) => {
            if (err) {
                console.error(err);
                return res.status(500).json({ error: err.message });
            }

            // Get all active timers and current recordings to mark them in the guide
            db.all("SELECT * FROM timers", (err, timers) => {
                db.all("SELECT * FROM recordings WHERE status = 'recording'", (err, recs) => {
                    const channels = Channels.CHANNELS.map(channel => {
                        let programs = rows.filter(p => {
                            const chanNum = channel.naturalNumber || (channel.number ? channel.number.toString().replace('-', '.') : '');
                            const progNum = p.channel_service_id ? p.channel_service_id.toString().replace('-', '.') : '';

                            const freqMatch = !p.frequency || channel.frequency == p.frequency;
                            if (!freqMatch) return false;

                            // If either has a dot, they must match exactly on the virtual channel number
                            if (chanNum.includes('.') || progNum.includes('.')) {
                                return chanNum === progNum;
                            }

                            // Otherwise fall back to a strict serviceId (Program Number) match
                            return channel.serviceId === p.channel_service_id;
                        });

                        // Deduplicate programs by start_time to prevent overlaps
                        const seenStarts = new Set();
                        programs = programs.filter(p => {
                            if (seenStarts.has(p.start_time)) return false;
                            seenStarts.add(p.start_time);
                            return true;
                        });

                        return {
                            ...channel,
                            programs: programs.map(p => {
                                const isScheduled = timers && timers.some(t =>
                                    (t.type === 'once' && t.channel_num === channel.number && t.start_time === p.start_time) ||
                                    (t.type === 'series' && t.title === p.title)
                                );
                                const isRecording = recs && recs.some(r =>
                                    r.channel_num === channel.number && r.start_time === p.start_time
                                );
                                return {
                                    title: p.title,
                                    description: p.description,
                                    start: p.start_time,
                                    end: p.end_time,
                                    scheduled: !!isScheduled,
                                    recording: !!isRecording
                                };
                            })
                        };
                    });
                    res.json({ channels });
                });
            });
        });
    });

    // DVR API: Timers
    app.get('/api/timers', (req, res) => {
        const sql = `
            SELECT t.*, 
                   (SELECT status FROM recordings r WHERE r.timer_id = t.id ORDER BY r.start_time DESC LIMIT 1) as last_status,
                   (SELECT id FROM recordings r WHERE r.timer_id = t.id ORDER BY r.start_time DESC LIMIT 1) as last_recording_id
            FROM timers t 
            ORDER BY t.created_at DESC`;
        db.all(sql, (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows);
        });
    });

    app.post('/api/timers', (req, res) => {
        const { type, title, channel_num, start_time, end_time } = req.body;
        db.run("INSERT INTO timers (type, title, channel_num, start_time, end_time) VALUES (?, ?, ?, ?, ?)",
            [type, title, channel_num, start_time, end_time],
            function (err) {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ id: this.lastID });
            }
        );
    });

    app.delete('/api/timers/:id', (req, res) => {
        db.run("DELETE FROM timers WHERE id = ?", [req.params.id], function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        });
    });

    // DVR API: Recordings
    app.get('/api/recordings', (req, res) => {
        db.all("SELECT * FROM recordings ORDER BY start_time DESC", (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows);
        });
    });

    app.post('/api/recordings/stop', (req, res) => {
        const { channel_num, start_time } = req.body;
        const recKey = `${channel_num}_${start_time}`;
        DVR.stopRecording(recKey);
        res.json({ success: true });
    });

    // Playback Endpoint: Transcode and stream a recording
    app.get(['/api/play/:id', '/api/play/:id/:format', '/api/play/:id/:format/:codec'], handleFileStream);

    app.delete('/api/recordings/:id', (req, res) => {
        db.get("SELECT file_path FROM recordings WHERE id = ?", [req.params.id], (err, row) => {
            if (row) {
                console.log(`[DVR] Deleting recording file: ${row.file_path}`);
                if (fs.existsSync(row.file_path)) {
                    try {
                        fs.unlinkSync(row.file_path);
                        console.log(`[DVR] Successfully deleted: ${row.file_path}`);
                    } catch (e) {
                        console.error(`[DVR] Failed to delete file: ${row.file_path}`, e);
                    }
                } else {
                    console.warn(`[DVR] File not found on disk: ${row.file_path}`);
                }
            }
            db.run("DELETE FROM recordings WHERE id = ?", [req.params.id], (err) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ success: true });
            });
        });
    });

    app.get('/', (req, res, next) => {
        next();
    });
}

module.exports = { setupRoutes };
