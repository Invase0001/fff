const fs = require('fs');
const path = require('path');

const DB_DIR = path.join(__dirname, '../../../lib/database');
const DB_FILE = path.join(DB_DIR, 'notifySettings.json');

class NotifySettings {
    static ensureDB() {
        if (!fs.existsSync(DB_DIR)) {
            fs.mkdirSync(DB_DIR, { recursive: true });
        }
        if (!fs.existsSync(DB_FILE)) {
            fs.writeFileSync(DB_FILE, JSON.stringify({ mentionRoleId: null }, null, 2), 'utf8');
        }
    }

    static load() {
        this.ensureDB();
        try {
            const data = fs.readFileSync(DB_FILE, 'utf8');
            return JSON.parse(data);
        } catch (err) {
            console.error('[NotifySettings] Error reading settings:', err.message);
            return { mentionRoleId: null };
        }
    }

    static save(data) {
        this.ensureDB();
        try {
            fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
            return true;
        } catch (err) {
            console.error('[NotifySettings] Error saving settings:', err.message);
            return false;
        }
    }

    static getMentionRoleId() {
        const data = this.load();
        return data.mentionRoleId || null;
    }

    static setMentionRole(roleId) {
        const data = this.load();
        data.mentionRoleId = roleId || null;
        this.save(data);
        return data.mentionRoleId;
    }
}

module.exports = NotifySettings;
