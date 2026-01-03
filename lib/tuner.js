const fs = require('fs');
const { ENABLE_PREEMPTION } = require('./config');
const { delay } = require('./utils');

let TUNERS = [];
let lastTunerIndex = -1;

function discoverTuners() {
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
}

async function acquireTuner(type = 'live') {
    // 1. Try to find a completely free tuner
    for (let i = 0; i < TUNERS.length; i++) {
        const nextIndex = (lastTunerIndex + 1 + i) % TUNERS.length;
        const potentialTuner = TUNERS[nextIndex];
        if (!potentialTuner.inUse) {
            lastTunerIndex = nextIndex;
            potentialTuner.usageType = type;
            return potentialTuner;
        }
    }

    // 2. Preemption Logic
    if (type === 'dvr') {
        // DVR can preempt Live streams
        for (let i = 0; i < TUNERS.length; i++) {
            const tuner = TUNERS[i];
            if (tuner.usageType === 'live' || tuner.epgScanning) {
                console.log(`[Tuner] DVR is preempting ${tuner.epgScanning ? 'EPG' : 'Live'} on Tuner ${tuner.id}`);
                if (tuner.killSwitch) tuner.killSwitch();

                // Wait for release
                for (let j = 0; j < 15; j++) {
                    if (!tuner.inUse) {
                        tuner.usageType = 'dvr';
                        return tuner;
                    }
                    await delay(200);
                }
            }
        }
    } else if (type === 'live' && ENABLE_PREEMPTION) {
        // Live can ONLY preempt other Live streams
        for (let i = 0; i < TUNERS.length; i++) {
            const tuner = TUNERS[i];
            if (tuner.usageType === 'live') {
                console.log(`[Tuner] Preempting Live stream on Tuner ${tuner.id} for new request`);
                if (tuner.killSwitch) tuner.killSwitch();

                for (let j = 0; j < 15; j++) {
                    if (!tuner.inUse) {
                        tuner.usageType = 'live';
                        return tuner;
                    }
                    await delay(200);
                }
            }
        }
    }

    // 3. Last ditch: wait a bit for ANY tuner to become free
    for (let i = 0; i < 5; i++) {
        await delay(1000);
        for (const tuner of TUNERS) {
            if (!tuner.inUse) {
                tuner.usageType = type;
                return tuner;
            }
        }
    }

    return null;
}

// Initial discovery
discoverTuners();

module.exports = {
    TUNERS,
    acquireTuner,
    discoverTuners
};
