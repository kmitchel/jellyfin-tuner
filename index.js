const express = require('express');
const { execSync } = require('child_process');
const { PORT, ENABLE_EPG } = require('./lib/config');
const { dbExists } = require('./lib/db');
const { TUNERS } = require('./lib/tuner');
const EPG = require('./lib/epg');
const { setupRoutes } = require('./lib/routes');
const { debugLog } = require('./lib/utils');

const app = express();

// Block all requests until EPG scan is complete
app.use((req, res, next) => {
    if (!EPG.isInitialScanDone) {
        res.set('Retry-After', '30');
        return res.status(503).send(`
            <html>
                <head>
                    <title>System Initializing</title>
                    <meta http-equiv="refresh" content="10">
                    <style>
                        body { background: #020617; color: #f8fafc; font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; text-align: center; }
                        .loader { border: 4px solid rgba(255,255,255,0.1); border-top: 4px solid #38bdf8; border-radius: 50%; width: 50px; height: 50px; animation: spin 1s linear infinite; margin: 0 auto 2rem; }
                        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
                        h1 { font-weight: 700; font-size: 2rem; margin: 0 0 1rem; color: #fff; }
                        p { color: #94a3b8; font-size: 1.1rem; }
                    </style>
                </head>
                <body>
                    <div>
                        <div class="loader"></div>
                        <h1>Signal Acquisition in Progress</h1>
                        <p>Performing a deep EPG scan across all tuners to build your guide.<br>The dashboard will load automatically in a moment.</p>
                    </div>
                </body>
            </html>
        `);
    }
    next();
});

// Serve static files
app.use(express.static('public'));

// Set up routes
setupRoutes(app);

// Get build number (git commit count)
let buildNumber = 'unknown';
try {
    buildNumber = execSync('git rev-list --count HEAD').toString().trim();
} catch (e) {
    debugLog('Could not determine build number from git');
}

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
        // If DB exists, we are ready immediately. Periodic background scan will update data later.
        console.log('Database found, skipping initial EPG scan.');
        EPG.isInitialScanDone = true;
    }
} else {
    console.log('EPG scanning is disabled.');
    EPG.isInitialScanDone = true;
}

app.listen(PORT, () => {
    console.log(`Tuner app (Build ${buildNumber}) listening at http://localhost:${PORT}`);
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
