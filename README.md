# Express M3U Tuner 📺

A high-performance ExpressJS server for turning your USB DVB/ATSC tuners into a network-accessible M3U playlist with full XMLTV Electronic Program Guide (EPG) support.

## 🚀 Features

- **Multi-Tuner Support**: Automatically discovers and manages multiple tuners in `/dev/dvb`.
- **EPG Engine**: Built-in parser for ATSC (EIT/VCT) and DVB program guides.
- **Smart Mapping**: Automatically maps ATSC Source IDs to Virtual Channel numbers (e.g., 55.1).
- **XMLTV Excellence**: Generates standard XMLTV files with local timezone support and proper entity escaping (no more "Rizzoli & Isles" ampersand crashes).
- **Auto-Disambiguation**: Automatically fixes duplicate channel names in your `channels.conf` by appending subchannel numbers.
- **Hardware Acceleration**: Support for Intel QSV hardware transcoding to reduce CPU load.
- **Smart Scanning**: Only runs a full EPG scan on startup if the database is missing; otherwise refreshes every 15 minutes.
- **Round-Robin Preemption**: Distributes tuner load and supports preemption logic.

## 🛠️ Prerequisites

- **Node.js**: v18 or higher.
- **dvbv5-zap**: Part of the `v4l-utils` package.
- **FFmpeg**: For streaming and transcoding.
- **SQLite3**: For EPG data storage.

```bash
# Ubuntu/Debian
sudo apt update
sudo apt install v4l-utils ffmpeg nodejs npm sqlite3
```

## 📦 Installation

1. Clone the repository into `/opt`:
   ```bash
   # Replace with your repository URL
   sudo git clone https://github.com/kmitchel/jellyfin-tuner.git /opt/jellyfin-tuner
   cd /opt/jellyfin-tuner
   ```

2. Set permissions for the `jellyfin` user:
   ```bash
   sudo chown -R jellyfin:jellyfin /opt/jellyfin-tuner
   ```

3. Install dependencies:
   ```bash
   sudo -u jellyfin npm install
   ```

4. Place your `channels.conf` in the project root:
   ```bash
   # Example generation for ATSC
   dvbv5-scan us-ATSC-center-frequencies-8VSB > channels.conf
   sudo chown jellyfin:jellyfin channels.conf
   ```

5. **Channel Icons (Optional)**:
   Create a `logos.json` in the project root to map channel numbers or names to icon URLs. An example file `logos.json.example` is provided:
   ```bash
   cp logos.json.example logos.json
   ```
   **Example `logos.json` structure:**
   ```json
   {
     "15.1": "https://example.com/abc-logo.png",
     "Bounce 55.2": "https://example.com/bounce.png"
   }
   ```
   The app will automatically include these in the M3U (`tvg-logo`) and XMLTV (`<icon src="..." />`) outputs.
   ```bash
   sudo chown jellyfin:jellyfin logos.json
   ```

## ⚙️ Systemd Service & Permissions

Running the application with `sudo` is discouraged for security reasons. Follow these steps to run the tuner as the `jellyfin` user.

### 1. Configure User Permissions
The `jellyfin` user needs access to the application files, the DVB hardware, and the Intel GPU (for QSV).

```bash
# Set ownership of the application directory
sudo chown -R jellyfin:jellyfin /opt/jellyfin-tuner

# Add jellyfin to the video and render groups for hardware access
sudo usermod -aG video,render jellyfin
```

### 2. Create the Systemd Service
If you haven't already, create the service file at `/etc/systemd/system/express-m3u-tuner.service`. You can use the provided file or create it manually:

```bash
sudo nano /etc/systemd/system/express-m3u-tuner.service
```

**Service File Content:**
```ini
[Unit]
Description=Express M3U Tuner Service
After=network.target

[Service]
Type=simple
User=jellyfin
Group=jellyfin
WorkingDirectory=/opt/jellyfin-tuner
ExecStart=/usr/bin/node index.js
Restart=always
Environment=ENABLE_TRANSCODING=false

# Access to DVB and GPU hardware
SupplementaryGroups=video render

[Install]
WantedBy=multi-user.target
```

### 3. Enable and Start
```bash
# Reload systemd to recognize the new service
sudo systemctl daemon-reload

# Enable (start on boot) and start the service now
sudo systemctl enable --now express-m3u-tuner

# Verify it is running
sudo systemctl status express-m3u-tuner
```

## 🚦 Usage
Once the service is active, the server is available on port `3000` (default). It will automatically restart if it crashes or the system reboots.

### Environment Variables

| Variable | Description | Default |
| :--- | :--- | :--- |
| `PORT` | Server port | `3000` |
| `CHANNELS_CONF` | Path to your channels file | `./channels.conf` |
| `ENABLE_TRANSCODING`| Toggle FFmpeg transcoding | `true` |
| `ENABLE_QSV` | Enable Intel QSV Hardware Accel | `false` |
| `ENABLE_PREEMPTION` | Allow tuners to be stolen | `false` |
| `VERBOSE_LOGGING` | Enable deep debug logs | `false` |

## 🔗 Endpoints

- **Lineup**: `http://localhost:3000/lineup.m3u`
- **EPG**: `http://localhost:3000/xmltv.xml`
- **Stream**: `http://localhost:3000/stream/:channelNum`

## 🧠 Technical Details

### EPG Storage
EPG data is stored in `epg.db`. The application enforces a strict uniqueness constraint on `(channel, start_time)` to prevent duplicate entries even when receiving redundant data from multiple muxes.

### ATSC Parsing
The parser handles Multi-String Structure (MSS) titles and correctly handles GPS-to-Unix epoch conversions, including duration bitmask fixes for North American broadcasts.

### Channel Disambiguation
If your `channels.conf` has multiple sections named `[Bounce]`, the app will automatically rename them to `[Bounce 55.1]`, `[Bounce 55.2]`, etc., and save the changes back to the file to ensure reliable tuning.

## 🔧 Troubleshooting

### Clearing Jellyfin EPG Cache
If you update your `channels.conf` or notice your guide is stale/incorrect in Jellyfin, you may need to clear Jellyfin's internal XMLTV cache. Jellyfin sometimes caches the XML structure even if the file on disk has changed.

1. **Stop Jellyfin Server**:
   ```bash
   sudo systemctl stop jellyfin
   ```

2. **Delete the Cache Directories**:
   - **Native Linux (Debian/Ubuntu)**:
     ```bash
     sudo rm -rf /var/cache/jellyfin/xmltv/
     sudo rm -rf /var/cache/jellyfin/*_channels
     ```
   - **Docker**:
     Locate your mapped `cache` volume and delete the `xmltv` folder within it.

3. **Start Jellyfin Server**:
   ```bash
   sudo systemctl start jellyfin
   ```

4. **Refresh Guide Data**:
   In the Jellyfin Dashboard, go to **Live TV** and click **Refresh Guide Data**.

### ⚠️ Known Issues

- **EPG Virtual Channel Mismatch**: In some broadcast environments, EPG data may occasionally display on the wrong subchannel (e.g., 15.3 program data appearing on 15.1). This is typically caused by inconsistencies in the broadcaster's metadata (Source ID/Service ID mapping) or overlapping signals from different transmitters.
- **Chromecast Connectivity**: Some users have reported that the Jellyfin Android/Chromecast application may repeatedly close its connection and restart the stream. This behavior appears unique to the Chromecast environment and may relate to how it handles the underlying MPEG-TS stream timing.

## 📄 License
ISC
