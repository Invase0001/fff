const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, '../../../lib/config.json');
let config = {};
try {
    if (fs.existsSync(configPath)) {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
} catch (e) {}

const host = config.hypixel?.host || "mc.hypixel.net";
const port = config.hypixel?.port || 25565;
const version = config.hypixel?.version || "1.8.9";
const auth = "mojang";
const viewDistance = "tiny";

module.exports = {
    host,
    port,
    version,
    auth,
    viewDistance,
    config
};