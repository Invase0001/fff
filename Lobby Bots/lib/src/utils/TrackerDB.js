const fs = require('fs');
const path = require('path');

const DB_DIR = path.join(__dirname, '../../../lib/database');
const DB_FILE = path.join(DB_DIR, 'tracked.json');

class TrackerDB {
    static ensureDB() {
        if (!fs.existsSync(DB_DIR)) {
            fs.mkdirSync(DB_DIR, { recursive: true });
        }
        if (!fs.existsSync(DB_FILE)) {
            fs.writeFileSync(DB_FILE, JSON.stringify({}, null, 2), 'utf8');
        }
    }

    static load() {
        this.ensureDB();
        try {
            const data = fs.readFileSync(DB_FILE, 'utf8');
            return JSON.parse(data);
        } catch (err) {
            console.error('[TrackerDB] Error reading database:', err.message);
            return {};
        }
    }

    static save(data) {
        this.ensureDB();
        try {
            fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
            return true;
        } catch (err) {
            console.error('[TrackerDB] Error saving database:', err.message);
            return false;
        }
    }

    static addPlayer(username, addedBy = 'System', note = '') {
        if (!username || typeof username !== 'string') return false;
        const cleanName = username.trim().replace(/^@/, '');
        const key = cleanName.toLowerCase();
        const db = this.load();

        const isNew = !db[key];
        db[key] = {
            username: cleanName,
            addedBy,
            note: note ? note.trim() : '',
            addedAt: db[key]?.addedAt || Date.now(),
            lastSeen: db[key]?.lastSeen || null,
            lastLobby: db[key]?.lastLobby || null
        };

        this.save(db);
        return { isNew, player: db[key] };
    }

    static removePlayer(username) {
        if (!username || typeof username !== 'string') return false;
        const key = username.trim().toLowerCase();
        const db = this.load();

        if (db[key]) {
            const removed = db[key];
            delete db[key];
            this.save(db);
            return removed;
        }
        return null;
    }

    static isTracked(username) {
        if (!username || typeof username !== 'string') return false;
        const key = username.trim().toLowerCase();
        const db = this.load();
        return !!db[key];
    }

    static getPlayer(username) {
        if (!username || typeof username !== 'string') return null;
        const key = username.trim().toLowerCase();
        const db = this.load();
        return db[key] || null;
    }

    static updateLastSeen(username, lobbyName) {
        if (!username || typeof username !== 'string') return;
        const key = username.trim().toLowerCase();
        const db = this.load();
        if (db[key]) {
            db[key].lastSeen = Date.now();
            db[key].lastLobby = lobbyName;
            this.save(db);
        }
    }

    static getAll() {
        const db = this.load();
        return Object.values(db);
    }

    static clear() {
        this.save({});
        return true;
    }
}

module.exports = TrackerDB;
