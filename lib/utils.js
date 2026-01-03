const { VERBOSE_LOGGING } = require('./config');

function debugLog(...args) {
    if (VERBOSE_LOGGING) {
        console.log('[DEBUG]', ...args);
    }
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function escapeXml(unsafe) {
    if (!unsafe) return '';
    return unsafe.replace(/[<>&"']/g, (c) => {
        switch (c) {
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '&': return '&amp;';
            case '"': return '&quot;';
            case "'": return '&apos;';
            default: return c;
        }
    });
}

function formatXmltvDate(ts) {
    const d = new Date(ts);
    const yr = d.getUTCFullYear();
    const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
    const da = String(d.getUTCDate()).padStart(2, '0');
    const ho = String(d.getUTCHours()).padStart(2, '0');
    const mi = String(d.getUTCMinutes()).padStart(2, '0');
    const se = String(d.getUTCSeconds()).padStart(2, '0');
    return `${yr}${mo}${da}${ho}${mi}${se} +0000`;
}

function parseDVBTime(mjd, bcd) {
    const year = Math.floor((mjd - 15078.2) / 365.25);
    const month = Math.floor((mjd - 14956.1 - Math.floor(year * 365.25)) / 30.6001);
    const day = mjd - 14956 - Math.floor(year * 365.25) - Math.floor(month * 30.6001);

    const hour = ((bcd >> 16) & 0x0F) + ((bcd >> 20) & 0x0F) * 10;
    const min = ((bcd >> 8) & 0x0F) + ((bcd >> 12) & 0x0F) * 10;
    const sec = (bcd & 0x0F) + ((bcd >> 4) & 0x0F) * 10;

    const date = new Date(Date.UTC(year + 1900, month - 1, day, hour, min, sec));
    return date.getTime();
}

module.exports = {
    debugLog,
    delay,
    escapeXml,
    formatXmltvDate,
    parseDVBTime
};
