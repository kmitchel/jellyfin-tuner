# Express M3U Tuner 📺

A high-performance ExpressJS server for turning your USB DVB/ATSC tuners into a network-accessible M3U playlist with full XMLTV Electronic Program Guide (EPG) support.

The focus of this project will return to a minimal solution to connect Jellyfin to OTA tuners, providing a EPG service and streaming the raw mpeg/ts to Jellyfin for further processing. https://github.com/kmitchel/ZapLink is a more comprehensive solution, that offer flexible transcoding, DVR functionality, and a feature rich program guide.

## 🚀 Features

- **Multi-Tuner Support**: Automatically discovers and manages multiple tuners in `/dev/dvb`.
- **EPG Engine**: Built-in parser for ATSC (EIT/VCT) and DVB program guides.
- **Smart Mapping**: Automatically maps ATSC Source IDs to Virtual Channel numbers (e.g., 55.1).
- **XMLTV Excellence**: Generates standard XMLTV files with local timezone support and proper entity escaping (no more "Rizzoli & Isles" ampersand crashes).
- **Smart Disambiguation**: Tunes using Virtual Channel numbers instead of section names, allowing multiple channels with the same name (e.g., "Bounce") to coexist without conflict.
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
     "55.2": "https://example.com/bounce.png"
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

### 2. Install the Systemd Service
The repository includes a pre-configured service file. Link it to your systemd directory:

```bash
# Link the service file to systemd
sudo ln -s /opt/jellyfin-tuner/express-m3u-tuner.service /etc/systemd/system/express-m3u-tuner.service
```

Alternatively, you can copy it manually if you prefer:
```bash
sudo cp /opt/jellyfin-tuner/express-m3u-tuner.service /etc/systemd/system/
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
| `ENABLE_TRANSCODING`| Toggle FFmpeg transcoding | `false` |
| `ENABLE_QSV` | Enable Intel QSV Hardware Accel | `false` |
| `ENABLE_PREEMPTION` | Allow tuners to be stolen | `false` |
| `VERBOSE_LOGGING` | Enable deep debug logs | `false` |

## 🐳 Docker Deployment

You can also run Express M3U Tuner using Docker, which simplifies dependency management.

### 1. Build and Run with Docker Compose
Ensuring your `channels.conf` is in the project root:

```bash
docker-compose up -d --build
```

### 2. Manual Docker Build & Run
```bash
# Build the image
docker build -t express-m3u-tuner .

# Run the container
docker run -d \
  --name express-m3u-tuner \
  --privileged \
  --network host \
  -v $(pwd)/channels.conf:/app/channels.conf \
  -v $(pwd)/logos.json:/app/logos.json \
  -v $(pwd)/epg.db:/app/epg.db \
  -v /dev/dvb:/dev/dvb \
  express-m3u-tuner
```

**Note:** The `--privileged` flag and `--network host` are recommended for reliable access to DVB hardware and low-latency streaming.

### 🎮 Hardware Acceleration (Intel QSV)

To enable Intel Quick Sync Video (QSV) inside Docker, you need to pass the GPU device to the container and set the appropriate environment variables.

#### 1. Update `docker-compose.yml`
Ensure your service includes the following:

```yaml
services:
  tuner:
    # ... other config ...
    devices:
      - /dev/dvb:/dev/dvb
      - /dev/dri:/dev/dri # Pass through the Intel GPU
    environment:
      - ENABLE_TRANSCODING=true
      - ENABLE_QSV=true
```

#### 2. Manual Docker Run with GPU
```bash
docker run -d \
  --name express-m3u-tuner \
  --privileged \
  --network host \
  --device /dev/dri:/dev/dri \
  -e ENABLE_TRANSCODING=true \
  -e ENABLE_QSV=true \
  -v $(pwd)/channels.conf:/app/channels.conf \
  -v $(pwd)/logos.json:/app/logos.json \
  -v $(pwd)/epg.db:/app/epg.db \
  -v /dev/dvb:/dev/dvb \
  express-m3u-tuner
```

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
The application uses the `VCHANNEL` number for tuning via `dvbv5-zap` instead of the section name. This means that if your `channels.conf` has multiple sections named `[Bounce]`, they will all stay as-is, and the app will reliably choose the correct one based on its unique subchannel number (e.g., 55.1 vs 55.2).

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

- **[SOLVED] EPG Virtual Channel Mismatch**: Previously, EPG data could occasionally display on the wrong subchannel. This was resolved by switching to virtual channel numbers for disambiguation and tuning, ensuring EPG data is correctly mapped and retrieved based on reliable channel identifiers.
- **Chromecast Connectivity**: Some users have reported that the Jellyfin Android/Chromecast application may repeatedly close its connection and restart the stream. This behavior appears unique to the Chromecast environment and may relate to how it handles the underlying MPEG-TS stream timing. [WORKAROUND] Configure Jellyfin on the Chromecast to transcode livetv streams.

## 📄 License
ISC
