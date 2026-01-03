const express = require('express');
const { PORT, ENABLE_EPG } = require('./lib/config');
const { dbExists } = require('./lib/db');
const { TUNERS } = require('./lib/tuner');
const EPG = require('./lib/epg');
const { setupRoutes } = require('./lib/routes');

const app = express();

// Set up routes
setupRoutes(app);

if (ENABLE_EPG) {
    // Schedule EPG grab every 15 minutes with a shorter 15s-per-mux timeout for background updates
    setInterval(() => EPG.grab(15000), 15 * 60 * 1000);

    // Priority: Initial grab on startup ONLY if database is missing
    if (!dbExists) {
        console.log('Database not found, performing initial deep EPG scan...');
        // Small delay to ensure tuners are ready
        // Deep scan (30s per mux)
        setTimeout(() => EPG.grab(30000), 2000);
    } else {
        // If DB exists, still run a quick scan after a short delay
        EPG.isInitialScanDone = true;
        setTimeout(() => EPG.grab(20000), 5000);
    }
} else {
    console.log('EPG scanning is disabled.');
    EPG.isInitialScanDone = true;
}

app.listen(PORT, () => {
    console.log(`Tuner app listening at http://localhost:${PORT}`);
});

// Global Cleanup on App Exit
function cleanExit() {
    console.log('\nApp stopping, ensuring all tuners are released...');
    TUNERS.forEach(tuner => {
        if (tuner.inUse && tuner.processes) {
            console.log(`Killing processes for Tuner ${tuner.id}`);
            if (tuner.processes.zap) try { tuner.processes.zap.kill('SIGKILL'); } catch (e) { }
            if (tuner.processes.ffmpeg) try { tuner.processes.ffmpeg.kill('SIGKILL'); } catch (e) { }
        }
    });
    process.exit();
}

process.on('SIGINT', cleanExit);
process.on('SIGTERM', cleanExit);
