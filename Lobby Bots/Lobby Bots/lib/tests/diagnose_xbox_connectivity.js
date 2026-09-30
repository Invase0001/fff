/**
 * Standalone connectivity diagnostic — NOT part of `npm test`.
 *
 * Run this directly on whichever machine is failing logins with a message like:
 *   "[AccountManager] fetchLocation failed for ... (HTTP 503) | body: <!DOCTYPE html>..."
 *
 * It sends the same first request AccountManager.loginCookie() sends, with no
 * cookies attached, once directly and once through every proxy in proxies.txt.
 * A healthy response is a redirect (300-399) or a login page (200) — that just
 * means "no session cookie", which is expected here since none was sent.
 * A 503/403/429, or a request that errors out entirely, means Microsoft's
 * edge is blocking or rate-limiting that specific IP, independent of cookies.
 *
 * Usage: node lib/tests/diagnose_xbox_connectivity.js
 */

const axios = require('axios');
const ProxyAgent = require('proxy-agent');
const ProxyManager = require('../src/utils/ProxyManager');

const TARGET_URL = 'https://sisu.xboxlive.com/connect/XboxLive/?state=login&cobrandId=8058f65d-ce06-4c30-9559-473c9275a65d&tid=896928775&ru=https%3A%2F%2Fwww.minecraft.net%2Fen-us%2Flogin&aid=1142970254';

const HEADERS = {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36'
};

async function probe(label, agent) {
    const config = {
        headers: HEADERS,
        maxRedirects: 0,
        maxHeaderSize: 65536,
        timeout: 15000,
        validateStatus: () => true // report whatever status comes back instead of throwing
    };
    if (agent) {
        config.httpAgent = agent;
        config.httpsAgent = agent;
    }

    try {
        const res = await axios.get(TARGET_URL, config);
        const healthy = (res.status >= 300 && res.status < 400) || res.status === 200;
        const tag = healthy ? 'OK ' : 'BAD';
        const bodySnippet = typeof res.data === 'string' ? res.data.replace(/\s+/g, ' ').slice(0, 120) : '';
        console.log(`[${tag}] ${label} -> HTTP ${res.status}${bodySnippet ? `  | ${bodySnippet}` : ''}`);
        return healthy;
    } catch (err) {
        console.log(`[BAD] ${label} -> ${err.code || err.message}`);
        return false;
    }
}

async function main() {
    console.log('Testing connectivity to sisu.xboxlive.com from this machine...\n');

    console.log('--- Direct (no proxy) ---');
    await probe('Direct connection');

    const proxies = ProxyManager.loadProxies();
    if (proxies.length === 0) {
        console.log('\nNo proxies found in lib/proxies.txt — skipping proxy tests.');
        return;
    }

    console.log(`\n--- Through ${proxies.length} proxy/proxies from proxies.txt ---`);
    let okCount = 0;
    for (const proxy of proxies) {
        const agent = new ProxyAgent(proxy.url);
        const ok = await probe(`${proxy.host}:${proxy.port}`, agent);
        if (ok) okCount++;
    }

    console.log(`\n${okCount}/${proxies.length} proxies reached sisu.xboxlive.com without being blocked.`);
}

main().catch(err => {
    console.error('Diagnostic script crashed:', err);
    process.exit(1);
});
