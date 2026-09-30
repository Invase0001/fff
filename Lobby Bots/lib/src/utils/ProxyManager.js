const fs = require('fs');
const path = require('path');
const axios = require('axios');
const ProxyAgent = require('proxy-agent');

const PROXIES_FILE = path.join(__dirname, '../../proxies.txt');

class ProxyManager {

    static parseProxyString(proxyString) {
        if (!proxyString || typeof proxyString !== 'string') return null;
        let str = proxyString.trim();
        if (!str || str.startsWith('#') || str.startsWith('//') || str.toLowerCase().includes('enter proxies')) {
            return null;
        }

        let protocol = 'socks5';
        if (str.includes('://')) {
            const parts = str.split('://');
            protocol = parts[0].toLowerCase();
            str = parts.slice(1).join('://');
        }

        let host = null;
        let port = null;
        let username = null;
        let password = null;

        if (str.includes('@')) {
            // user:pass@host:port
            const atIndex = str.lastIndexOf('@');
            const auth = str.substring(0, atIndex);
            const endpoint = str.substring(atIndex + 1);

            const authColon = auth.indexOf(':');
            if (authColon !== -1) {
                username = auth.substring(0, authColon);
                password = auth.substring(authColon + 1);
            } else {
                username = auth;
            }

            const endpointParts = endpoint.split(':');
            host = endpointParts[0];
            port = parseInt(endpointParts[1], 10);
        } else {
            const parts = str.split(':');
            if (parts.length === 2) {
                // host:port
                host = parts[0];
                port = parseInt(parts[1], 10);
            } else if (parts.length >= 4) {
                // Check if parts[1] is port (host:port:user:pass)
                if (!isNaN(parseInt(parts[1], 10))) {
                    host = parts[0];
                    port = parseInt(parts[1], 10);
                    username = parts[2];
                    password = parts.slice(3).join(':');
                } else if (!isNaN(parseInt(parts[parts.length - 1], 10))) {
                    // user:pass:host:port
                    username = parts[0];
                    password = parts[1];
                    host = parts[2];
                    port = parseInt(parts[3], 10);
                }
            }
        }

        if (!host || !port || isNaN(port)) {
            return null;
        }

        if (port === 80 || port === 8080 || port === 3128 || port === 8888) {
            protocol = 'http';
        }

        const authPrefix = (username && password) ? `${username}:${password}@` : '';
        const url = `${protocol}://${authPrefix}${host}:${port}`;
        const string = (username && password) ? `${host}:${port}:${username}:${password}` : `${host}:${port}`;

        return {
            protocol,
            host,
            port,
            username,
            password,
            url,
            string,
            raw: proxyString.trim()
        };
    }

    static loadProxies() {
        if (!fs.existsSync(PROXIES_FILE)) {
            fs.writeFileSync(PROXIES_FILE, '');
            return [];
        }

        const lines = fs.readFileSync(PROXIES_FILE, 'utf-8')
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(line => line.length > 0);

        const proxies = [];
        for (const line of lines) {
            const parsed = this.parseProxyString(line);
            if (parsed) {
                proxies.push(parsed);
            }
        }

        return proxies;
    }

    static saveProxies(proxies) {
        const lines = proxies.map(p => {
            if (typeof p === 'string') return p;
            return p.raw || p.url || p.string;
        });
        fs.writeFileSync(PROXIES_FILE, lines.join('\n'), 'utf-8');
    }

    static importProxiesFromText(text) {
        if (!text || typeof text !== 'string') return 0;

        const lines = text.split(/\r?\n/)
            .map(l => l.trim())
            .filter(l => l.length > 0);

        const validProxies = [];
        for (const line of lines) {
            const parsed = this.parseProxyString(line);
            if (parsed) {
                validProxies.push(parsed);
            }
        }

        this.saveProxies(validProxies);
        return validProxies.length;
    }

    static async validateProxy(proxy, apis = ['https://api.ipify.org?format=json', 'https://checkip.amazonaws.com', 'https://ip.seeip.org']) {
        const proxyObj = typeof proxy === 'string' ? this.parseProxyString(proxy) : proxy;
        if (!proxyObj) return false;

        const agent = new ProxyAgent(proxyObj.url);
        const timeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), ms));

        try {
            await Promise.any(apis.map(api =>
                Promise.race([
                    axios.get(api, { httpAgent: agent, httpsAgent: agent, timeout: 10000 }),
                    timeout(10000)
                ])
            ));
            return true;
        } catch {
            return false;
        }
    }

    static async validateAllProxies() {
        const proxies = this.loadProxies();
        if (proxies.length === 0) return { working: [], failed: [] };

        const results = await Promise.all(proxies.map(async (p) => {
            const isValid = await this.validateProxy(p);
            return { proxy: p, isValid };
        }));

        const working = results.filter(r => r.isValid).map(r => r.proxy);
        const failed = results.filter(r => !r.isValid).map(r => r.proxy);

        // Retain only working proxies in the file
        if (working.length > 0) {
            this.saveProxies(working);
        }

        return { working, failed };
    }

    static activeAssignments = new Map(); // botId -> proxyString

    static async acquireProxy(botId = null) {
        const proxies = this.loadProxies();
        if (proxies.length === 0) {
            return null;
        }

        // If this bot already has an assigned proxy, return it
        if (botId && this.activeAssignments.has(botId)) {
            const assignedStr = this.activeAssignments.get(botId);
            const existing = proxies.find(p => p.string === assignedStr || p.raw === assignedStr || p.url === assignedStr);
            if (existing) return existing;
        }

        // Find proxies not currently in use by any other active bot
        const inUse = new Set(this.activeAssignments.values());
        const available = proxies.filter(p => !inUse.has(p.string) && !inUse.has(p.raw) && !inUse.has(p.url));

        // Prefer an unused proxy, otherwise fall back to any proxy
        const chosen = (available.length > 0)
            ? available[Math.floor(Math.random() * available.length)]
            : proxies[Math.floor(Math.random() * proxies.length)];

        if (botId && chosen) {
            this.activeAssignments.set(botId, chosen.string || chosen.raw || chosen.url);
        }

        return chosen;
    }

    static releaseProxy(botId) {
        if (botId && this.activeAssignments.has(botId)) {
            this.activeAssignments.delete(botId);
        }
    }

    static clearAssignments() {
        this.activeAssignments.clear();
    }

    static async getRandomProxy() {
        return this.acquireProxy(null);
    }

    static removeProxy(proxyInput) {
        const proxyStr = typeof proxyInput === 'string' ? proxyInput : (proxyInput?.string || proxyInput?.raw || proxyInput?.url);
        if (!proxyStr) return;

        let proxies = this.loadProxies();
        proxies = proxies.filter(p => p.string !== proxyStr && p.raw !== proxyStr && p.url !== proxyStr);
        this.saveProxies(proxies);
    }
}

module.exports = ProxyManager;