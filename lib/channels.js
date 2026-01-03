const fs = require('fs');
const path = require('path');
const { CHANNELS_CONF } = require('./config');

let CHANNELS = [];

function getLatestLogos() {
    try {
        const logoPath = path.resolve(process.cwd(), 'logos.json');
        if (fs.existsSync(logoPath)) {
            return JSON.parse(fs.readFileSync(logoPath, 'utf8'));
        }
    } catch (e) {
        console.warn('[Config] Failed to parse logos.json:', e);
    }
    return {};
}

function loadChannels() {
    console.log(`Loading channels from ${CHANNELS_CONF}...`);
    try {
        if (!fs.existsSync(CHANNELS_CONF)) {
            console.warn('Channels config not found, using empty list.');
            return;
        }

        const data = fs.readFileSync(CHANNELS_CONF, 'utf8');
        const entries = data.split('[');

        // Load logos if logos.json exists
        const logos = getLatestLogos();
        console.log(`[Config] Loaded ${Object.keys(logos).length} icons from logos.json`);

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
                    icon: logos[vChannel] || logos[name] || null,
                    rawConfig: `[${name}]\n${entry.substring(entry.indexOf(']') + 1).trim()}`
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

// Initial load
loadChannels();

module.exports = {
    get CHANNELS() { return CHANNELS; },
    loadChannels,
    getLatestLogos
};
