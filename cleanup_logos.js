const fs = require('fs');

const logos = JSON.parse(fs.readFileSync('logos.json', 'utf8'));
const filteredLogos = {};

// Regex to match "2.1", "15.1", etc. (digits followed by a dot and digits)
// We also allow single numbers if they are intended as channel identifiers
const channelNumberRegex = /^\d+(\.\d+)?$/;

for (const [key, value] of Object.entries(logos)) {
    if (channelNumberRegex.test(key)) {
        filteredLogos[key] = value;
    }
}

fs.writeFileSync('logos.json', JSON.stringify(filteredLogos, null, 2));

console.log(`Filtered logos.json. Kept ${Object.keys(filteredLogos).length} numeric channel entries.`);
