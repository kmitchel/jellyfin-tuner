# Use Node.js 18 Bullseye Slim for a balance of size and compatibility
FROM node:18-bullseye-slim

# Install system dependencies
# v4l-utils: provides dvbv5-zap
# ffmpeg: for streaming and transcoding
# g++ make python3: required for building sqlite3 if binary is not available
RUN apt-get update && apt-get install -y \
    v4l-utils \
    ffmpeg \
    sqlite3 \
    g++ \
    make \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node.js dependencies
RUN npm install

# Copy application source
COPY . .

# Create directory for EPG database if it doesn't exist (though it will be created by sqlite3)
# We might want to mount /app/epg.db to the host to persist guide data
# VOLUME [ "/app/epg.db" ]

# Default environment variables
ENV PORT=3000
ENV CHANNELS_CONF=/app/channels.conf
ENV ENABLE_TRANSCODING=false
ENV ENABLE_QSV=false
ENV ENABLE_PREEMPTION=false
ENV VERBOSE_LOGGING=false

# Expose port
EXPOSE 3000

# Start the application
CMD ["node", "index.js"]
