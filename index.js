const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Tuner Configuration
// Adjust these adapter paths based on your system (e.g., /dev/dvb/adapter0, /dev/dvb/adapter1)
const TUNERS = [
    { id: 0, adapter: '/dev/dvb/adapter0', inUse: false },
    { id: 1, adapter: '/dev/dvb/adapter1', inUse: false }
];

const CHANNELS_CONF = process.env.CHANNELS_CONF || '/etc/dvb/channels.conf';

// Mock Channel List - Replace with actual frequency data
const CHANNELS = [
    { number: '45.1', name: 'WFWC-CD', serviceId: 1001 },
    { number: '45.2', name: 'WFWC-CD', serviceId: 1002 },
    { number: '45.3', name: 'WFWC-CD', serviceId: 1003 },
    { number: '45.4', name: 'WFWC-CD', serviceId: 1004 },
    { number: '45.5', name: 'WFWC-CD', serviceId: 1005 },
    { number: '45.6', name: 'WFWC-CD', serviceId: 1006 },
    { number: '45.7', name: 'WFWC-CD', serviceId: 1007 },
    { number: '45.8', name: 'WFWC-CD', serviceId: 1008 },
    { number: '38.1', name: 'WEIJ HD', serviceId: 3 },
    { number: '38.4', name: 'COZI TV', serviceId: 6 },
    { number: '38.2', name: 'SBN', serviceId: 4 },
    { number: '38.8', name: 'QUEST', serviceId: 10 },
    { number: '38.5', name: 'IONPLUS', serviceId: 7 },
    { number: '38.9', name: 'ONTV4U', serviceId: 11 },
    { number: '38.7', name: 'TOONS', serviceId: 9 },
    { number: '38.10', name: 'BIZ TV', serviceId: 12 },
    { number: '38.3', name: 'WEST', serviceId: 5 },
    { number: '38.6', name: 'JTV', serviceId: 8 },
    { number: '38.11', name: 'GDT', serviceId: 13 },
    { number: '39.1', name: 'PBS FW', serviceId: 1 },
    { number: '39.2', name: 'PBSKIDS', serviceId: 2 },
    { number: '39.3', name: 'CREATE', serviceId: 3 },
    { number: '39.4', name: 'World', serviceId: 4 },
    { number: '39.5', name: 'PBS WX', serviceId: 5 },
    { number: '39.6', name: 'PBS ARS', serviceId: 6 },
    { number: '55.1', name: 'WFFT-TV', serviceId: 3 },
    { number: '55.2', name: 'Bounce', serviceId: 4 },
    { number: '55.3', name: 'Antenna', serviceId: 5 },
    { number: '16.1', name: 'WCUH-LD', serviceId: 1001 },
    { number: '16.2', name: 'WCUH-LD', serviceId: 1002 },
    { number: '16.3', name: 'WCUH-LD', serviceId: 1003 },
    { number: '16.4', name: 'WCUH-LD', serviceId: 1004 },
    { number: '16.5', name: 'WCUH-LD', serviceId: 1005 },
    { number: '16.6', name: 'WCUH-LD', serviceId: 1006 },
    { number: '16.7', name: 'WCUH-LD', serviceId: 1007 },
    { number: '21.1', name: 'WPTAABC', serviceId: 1 },
    { number: '21.2', name: 'WPTANBC', serviceId: 2 },
    { number: '21.3', name: 'WPTAMY', serviceId: 3 },
    { number: '15.1', name: 'WANE-HD', serviceId: 3 },
    { number: '15.2', name: 'ION', serviceId: 4 },
    { number: '15.3', name: 'LAFF', serviceId: 5 },
    { number: '15.4', name: 'Escape', serviceId: 6 },
    { number: '33.1', name: 'WISECW', serviceId: 1 },
    { number: '33.2', name: 'Justice', serviceId: 2 },
    { number: '33.3', name: 'Grit', serviceId: 3 },
    { number: '33.4', name: 'CourtTV', serviceId: 4 },
    { number: '33.5', name: 'Start', serviceId: 5 },
    { number: '33.6', name: 'MeTV', serviceId: 6 },
    { number: '33.7', name: 'DABL', serviceId: 7 }
];

// Helper to get an available tuner
function getFreeTuner() {
    // Helper: Promise-based delay
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

    // Helper: Acquire a tuner, preempting if necessary
    async function acquireTuner() {
        // 1. Try to find a free tuner
        let tuner = TUNERS.find(t => !t.inUse);
        if (tuner) return tuner;

        // 2. If all busy, try to preempt one (LIFO/FIFO policy? Just pick the first for now)
        // We prefer a tuner that is not 'cleaningUp' (i.e. currently streaming).
        tuner = TUNERS.find(t => !t.cleaningUp);

        if (tuner) {
            console.log(`Preempting Tuner ${tuner.id} for new request request...`);
            if (tuner.killSwitch) {
                tuner.killSwitch(); // Trigger cleanup of the active stream
            }
            // Wait for it to become free (max 3s)
            for (let i = 0; i < 15; i++) {
                if (!tuner.inUse) return tuner;
                await delay(200);
            }
            console.warn(`Tuner ${tuner.id} failed to release after preemption.`);
        }

        // 3. Last ditch: wait for any tuner
        for (let i = 0; i < 10; i++) {
            tuner = TUNERS.find(t => !t.inUse);
            if (tuner) return tuner;
            await delay(500);
        }

        return null;
    }

    // Generate M3U Playlist
    app.get('/lineup.m3u', (req, res) => {
        let m3u = '#EXTM3U\n';
        const host = req.headers.host;

        CHANNELS.forEach(channel => {
            m3u += `#EXTINF:-1 tvg-id="${channel.number}" tvg-name="${channel.name}",${channel.name}\n`;
            m3u += `http://${host}/stream/${channel.number}\n`;
        });

        res.set('Content-Type', 'audio/x-mpegurl');
        res.send(m3u);
    });

    // Stream Endpoint
    app.get('/stream/:channelNum', async (req, res) => {
        const channelNum = req.params.channelNum;
        const channel = CHANNELS.find(c => c.number === channelNum);

        if (!channel) {
            return res.status(404).send('Channel not found');
        }

        // Acquire tuner with preemption
        const tuner = await acquireTuner();

        if (!tuner) {
            return res.status(503).send('No tuners available');
        }

        console.log(`Starting stream for ${channel.name} on Tuner ${tuner.id}`);
        tuner.inUse = true;
        tuner.processes = {};

        // Generate a temporary config entry to ensure unique tuning by Service ID
        // valid channels.conf format is INI-style:
        // [Name]
        //    KEY = VALUE
        const fs = require('fs');
        const path = require('path');
        const os = require('os');

        // Read the main channels config
        let configContent = '';
        try {
            configContent = fs.readFileSync(CHANNELS_CONF, 'utf8');
        } catch (e) {
            console.error('Failed to read channels.conf', e);
            // Release tuner if config fails
            tuner.inUse = false;
            return res.status(500).send('Config error');
        }

        // Find the block corresponding to the requested channel name AND Service ID
        // We are looking for a block starting with [channel.name] and containing SERVICE_ID = channel.serviceId
        // Since names are duplicate, we must iterate all blocks with that name.

        // Simple parser: split by headlines
        const entries = configContent.split('[');
        let matchedBlock = null;

        for (const entry of entries) {
            if (!entry.trim()) continue;
            const lines = entry.split('\n');
            const entryName = lines[0].replace(']', '').trim();

            if (entryName === channel.name) {
                // Check for service ID
                const serviceIdLine = lines.find(l => l.trim().startsWith('SERVICE_ID'));
                if (serviceIdLine && serviceIdLine.includes(channel.serviceId)) {
                    matchedBlock = `[${channel.name}-${channel.serviceId}]\n` + lines.slice(1).join('\n');
                    break;
                }
            }
        }

        if (!matchedBlock) {
            console.error(`Could not find config entry for ${channel.name} with SID ${channel.serviceId}`);
            // Fallback to name-only tuning (might pick wrong one)
            matchedBlock = `[${channel.name}]\nSERVICE_ID=${channel.serviceId}\n`; // unsafe fallback
        }

        // Write temp config
        const tempConfPath = path.join(os.tmpdir(), `zap-${tuner.id}-${channel.serviceId}.conf`);
        fs.writeFileSync(tempConfPath, matchedBlock); // matchedBlock already starts with [

        // 1. Start dvbv5-zap with temp config
        // We use the UNIQUE name we just generated: "Name-ServiceID"
        const uniqueName = `${channel.name}-${channel.serviceId}`;

        const zap = spawn('dvbv5-zap', [
            '-c', tempConfPath,
            '-r',
            '-a', tuner.id,
            uniqueName
        ]);
        tuner.processes.zap = zap;

        zap.on('error', (err) => {
            console.error(`Tuner ${tuner.id} zap error:`, err);
            // If zap fails to start, cleanup immediately
            cleanup();
            if (!res.headersSent) res.status(500).send('Tuner error');
        });

        // Wait slightly for lock? Or just start ffmpeg immediately. 
        // Usually safe to start ffmpeg immediately as it will block on reading dvr0 until data arrives.

        // Wait for the tuner to lock and populate the DVR buffer
        // This prevents ffmpeg from failing to find the program ID in the initial probe
        console.log('Waiting for tuner lock...');
        await delay(500); // Reduced to 500ms

        // 2. Start ffmpeg to read from dvr0 and pipe to response
        const dvrPath = `${tuner.adapter}/dvr0`;

        // FFmpeg options:
        // -i : input path
        // -c copy : copy stream
        // -f mpegts : output format
        const ffmpegArgs = [
            '-analyzeduration', '1000000',
            '-probesize', '1000000',
            '-i', dvrPath,
            '-c', 'copy',
            '-f', 'mpegts',
            'pipe:1'
        ];

        console.log(`Spawning FFmpeg with args: ${ffmpegArgs.join(' ')}`);
        const ffmpeg = spawn('ffmpeg', ffmpegArgs);
        tuner.processes.ffmpeg = ffmpeg;

        res.writeHead(200, {
            'Content-Type': 'video/mp2t',
            'Connection': 'keep-alive'
        });

        // Handle ffmpeg output pipe errors (e.g. client disconnect)
        ffmpeg.stdout.on('error', (err) => {
            if (err.code === 'EPIPE' || err.code === 'ECONNRESET') {
                console.log(`FFmpeg EPIPE/ECONNRESET [Tuner ${tuner.id}] - client likely disconnected`);
                cleanup();
            } else {
                console.error(`FFmpeg stdout error [Tuner ${tuner.id}]:`, err);
            }
        });

        ffmpeg.stdout.pipe(res).on('error', (err) => {
            console.warn(`Response pipe error [Tuner ${tuner.id}]:`, err);
            cleanup();
        });

        // Logging helpers
        ffmpeg.stderr.on('data', (data) => console.log(`FFmpeg [Tuner ${tuner.id}]: ${data}`));
        zap.stderr.on('data', (data) => console.log(`Zap [Tuner ${tuner.id}]: ${data}`));

        // Cleanup function
        const cleanup = () => {
            if (tuner.cleaningUp) return;
            tuner.cleaningUp = true;

            console.log(`Cleaning up Tuner ${tuner.id}`);

            // Remove the killSwitch reference so we don't call it again
            tuner.killSwitch = null;

            // Kill processes
            if (tuner.processes.zap) tuner.processes.zap.kill('SIGTERM');
            if (tuner.processes.ffmpeg) tuner.processes.ffmpeg.kill('SIGTERM');

            // Safety timeout to force release if processes hang
            const forceReleaseTimeout = setTimeout(() => {
                console.warn(`Force releasing Tuner ${tuner.id} after timeout`);
                if (tuner.processes.zap) try { tuner.processes.zap.kill('SIGKILL'); } catch (e) { }
                if (tuner.processes.ffmpeg) try { tuner.processes.ffmpeg.kill('SIGKILL'); } catch (e) { }
            }, 2000);

            // Allow one final clearing of timeout if zap exits cleanly before timeout
            tuner.forceReleaseTimeout = forceReleaseTimeout;
        };

        // Attach killSwitch for preemption
        tuner.killSwitch = cleanup;

        // release tuner only when zap exits (lock released)
        zap.on('exit', (code, signal) => {
            console.log(`Zap exited [Tuner ${tuner.id}] (code: ${code}, signal: ${signal})`);

            if (tuner.forceReleaseTimeout) {
                clearTimeout(tuner.forceReleaseTimeout);
                tuner.forceReleaseTimeout = null;
            }

            // Always mark free on zap exit, as the hardware lock is definitely gone
            tuner.inUse = false;
            tuner.cleaningUp = false;
            tuner.killSwitch = null;
            tuner.processes = {};
            console.log(`Tuner ${tuner.id} marked as FREE`);
        });

        ffmpeg.on('exit', (code) => {
            console.log(`FFmpeg exited [Tuner ${tuner.id}] with code ${code}`);
            // If ffmpeg dies, we must kill zap to stop tuning
            cleanup();
        });

        // Client disconnect handling
        const onDisconnect = () => {
            console.log(`Client disconnected (socket close) [Tuner ${tuner.id}]`);
            cleanup();
        };
        req.on('close', onDisconnect);
        res.on('close', onDisconnect);

        // Handle zap errors
        zap.on('error', (err) => {
            console.error(`Tuner ${tuner.id} zap error:`, err);
            cleanup();
        });
    });

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
