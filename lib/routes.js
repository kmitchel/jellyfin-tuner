const Channels = require('./channels');
const { db } = require('./db');
const { escapeXml, formatXmltvDate } = require('./utils');
const { handleStream } = require('./stream');
const { ENABLE_EPG } = require('./config');

function setupRoutes(app) {
    // Playlist Endpoint
    app.get('/playlist.m3u', (req, res) => {
        const host = req.get('host');
        let m3u = '#EXTM3U\n';

        Channels.CHANNELS.forEach(channel => {
            let logoAttr = channel.icon ? ` tvg-logo="${channel.icon}"` : '';
            m3u += `#EXTINF:-1 tvg-id="${channel.number}" tvg-name="${channel.name}"${logoAttr},${channel.name}\n`;
            m3u += `http://${host}/stream/${channel.number}\n`;
        });

        res.set('Content-Type', 'audio/x-mpegurl');
        res.send(m3u);
    });

    // XMLTV Endpoint
    app.get('/xmltv.xml', (req, res) => {
        const sendXml = (rows = []) => {
            let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
            xml += '<tv generator-info-name="Express M3U Tuner">\n';

            // Channels
            Channels.CHANNELS.forEach(c => {
                const icon = c.icon;
                xml += `  <channel id="${c.number}">\n`;
                xml += `    <display-name>${escapeXml(c.name)}</display-name>\n`;
                if (icon) xml += `    <icon src="${escapeXml(icon)}" />\n`;
                xml += '  </channel>\n';
            });

            // Programs
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

        if (!ENABLE_EPG) {
            return sendXml();
        }

        db.all("SELECT * FROM programs WHERE end_time > ? ORDER BY frequency, channel_service_id, start_time", [Date.now()], (err, rows) => {
            if (err) {
                console.error(err);
                return res.status(500).send(err.message);
            }
            sendXml(rows);
        });
    });

    // Stream Endpoint
    app.get('/stream/:channelNum', handleStream);

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

    // Default Route (Placeholder if static file not found)
    app.get('/', (req, res, next) => {
        // If index.html exists in public, express.static will handle it.
        // This is a fallback or can be removed if express.static is configured correctly.
        next();
    });
}

module.exports = { setupRoutes };
