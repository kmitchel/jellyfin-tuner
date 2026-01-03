const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const { dbPath } = require('./config');

const dbExists = fs.existsSync(dbPath);
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS programs (
        frequency TEXT,
        channel_service_id TEXT,
        start_time INTEGER,
        end_time INTEGER,
        title TEXT,
        description TEXT,
        event_id INTEGER,
        source_id INTEGER,
        PRIMARY KEY (frequency, channel_service_id, start_time)
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_end_time ON programs(end_time)`);
});

module.exports = {
    db,
    dbExists
};
