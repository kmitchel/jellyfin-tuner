const Channels = require('./channels');
const { db } = require('./db');
const { escapeXml, formatXmltvDate } = require('./utils');
const { handleStream } = require('./stream');
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

            const channels = Channels.CHANNELS.map(channel => {
                const programs = rows.filter(p => {
                    if (p.frequency) {
                        return channel.frequency == p.frequency && (channel.number == p.channel_service_id || channel.serviceId == p.channel_service_id);
                    }
                    return channel.serviceId == p.channel_service_id || channel.number == p.channel_service_id;
                });

                return {
                    ...channel,
                    programs: programs.map(p => ({
                        title: p.title,
                        description: p.description,
                        start: p.start_time,
                        end: p.end_time
                    }))
                };
            });

            res.json({ channels });
        });
    });

    app.get('/', (req, res, next) => {
        next();
    });
}

module.exports = { setupRoutes };
