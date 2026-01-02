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

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/express-m3u-tuner.git
   cd express-m3u-tuner
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Place your `channels.conf` in the project root:
   ```bash
   # Example generation for ATSC
   dvbv5-scan us-ATSC-center-frequencies-8VSB > channels.conf
   ```

## 🚦 Usage

Start the server (usually requires `sudo` or being in the `video` group to access DVB devices):

```bash
sudo npm start
```

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

## 📄 License
ISC
