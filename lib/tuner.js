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

async function acquireTuner() {
    // 1. Try Round-Robin to find a free tuner that wasn't the last one used
    for (let i = 0; i < TUNERS.length; i++) {
        const nextIndex = (lastTunerIndex + 1 + i) % TUNERS.length;
        const potentialTuner = TUNERS[nextIndex];
        if (!potentialTuner.inUse) {
            lastTunerIndex = nextIndex;
            return potentialTuner;
        }
    }

    // 2. If all busy, try to preempt one 
    if (ENABLE_PREEMPTION) {
        const preemptIndex = (lastTunerIndex + 1) % TUNERS.length;
        const tuner = TUNERS[preemptIndex];

        if (tuner && !tuner.epgScanning) { // Don't preempt EPG scan, it releases soon anyway
            console.log(`Preempting Tuner ${tuner.id} for new request...`);
            if (tuner.killSwitch) {
                tuner.killSwitch();
            }
            // Wait for it to become free (max 3s)
            for (let i = 0; i < 15; i++) {
                if (!tuner.inUse) {
                    lastTunerIndex = preemptIndex;
                    return tuner;
                }
                await delay(200);
            }
        }
    }

    // 3. Last ditch: wait for any tuner 
    for (let i = 0; i < 10; i++) {
        for (let j = 0; j < TUNERS.length; j++) {
            const idx = (lastTunerIndex + 1 + j) % TUNERS.length;
            if (!TUNERS[idx].inUse) {
                lastTunerIndex = idx;
                return TUNERS[idx];
            }
        }
        await delay(500);
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
