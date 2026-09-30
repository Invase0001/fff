const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const qs = require('qs');
const puppeteer = require('puppeteer');
const base64 = require('base-64');
const utf8 = require('utf8');
const ProxyAgent = require('proxy-agent');
const { Agent: UndiciAgent, ProxyAgent: UndiciProxyAgent, request: undiciRequest } = require('undici');
const ProxyManager = require('./ProxyManager');

// Node's core http/https client enforces a hardcoded response-header size limit
// (16KB by default) that can only be raised via a process-start flag
// (--max-http-header-size), which depends on how the host actually launches the
// process and has repeatedly not been in effect in production. undici's Agent
// takes maxHeaderSize as a plain constructor option instead, so it works
// regardless of how the process was started. Used only for fetchLocation(),
// which is where Xbox Live's oversized redirect/cookie headers actually
// overflow the limit.
const UNDICI_MAX_HEADER_SIZE = 262144; // 256KB - generous headroom over the ~16-64KB seen so far

function buildUndiciDispatcher(proxy) {
    if (proxy && proxy.host && proxy.port) {
        // undici's ProxyAgent speaks HTTP CONNECT to the proxy itself. Even though
        // ProxyManager labels these proxies "socks5" by default, the provider(s) in
        // use here have been confirmed to also accept plain HTTP CONNECT on the same
        // host:port, so this doesn't require a second proxy protocol to be configured.
        const authPrefix = (proxy.username && proxy.password) ? `${proxy.username}:${proxy.password}@` : '';
        const proxyUrl = `http://${authPrefix}${proxy.host}:${proxy.port}`;
        return new UndiciProxyAgent({ uri: proxyUrl, maxHeaderSize: UNDICI_MAX_HEADER_SIZE });
    }
    return new UndiciAgent({ maxHeaderSize: UNDICI_MAX_HEADER_SIZE });
}

const ACCOUNTS_DIR = path.join(__dirname, '../../accounts');

const CLIENT_ID = "54fd49e4-2103-4044-9603-2b028c814ec3";
const OAUTH20_TOKEN_LINK = "https://login.live.com/oauth20_token.srf";
const XBL_LINK = "https://user.auth.xboxlive.com/user/authenticate";
const XSTS_LINK = "https://xsts.auth.xboxlive.com/xsts/authorize";
const MC_SERVICES_LINK = "https://api.minecraftservices.com/authentication/login_with_xbox";
const OWNERSHIP_LINK = "https://api.minecraftservices.com/entitlements/mcstore";
const PROFILE_LINK = "https://api.minecraftservices.com/minecraft/profile";

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Promise Rejection:', reason);
});

class AccountManager {

    static ensureAccountsDir() {
        if (!fs.existsSync(ACCOUNTS_DIR)) {
            fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
        }
    }

    static getAccountsDir() {
        AccountManager.ensureAccountsDir();
        return ACCOUNTS_DIR;
    }

    static importAccountsFromZip(zipBuffer) {
        AccountManager.ensureAccountsDir();
        const AdmZip = require('adm-zip');
        const zip = new AdmZip(zipBuffer);
        const zipEntries = zip.getEntries();
        let importedCount = 0;

        for (const entry of zipEntries) {
            if (entry.isDirectory) continue;
            const entryName = path.basename(entry.entryName);
            if (entryName.toLowerCase().endsWith('.txt') || entryName.toLowerCase().endsWith('.json')) {
                const targetPath = path.join(ACCOUNTS_DIR, entryName);
                fs.writeFileSync(targetPath, entry.getData());
                importedCount++;
            }
        }
        return importedCount;
    }

    static loadAccountsByType(accountType) {
        AccountManager.ensureAccountsDir();
        const accountFiles = fs.readdirSync(ACCOUNTS_DIR).filter(file => {
            if (accountType === 'microsoft' && file.endsWith('.json')) {
                try {
                    const accountData = JSON.parse(fs.readFileSync(path.join(ACCOUNTS_DIR, file), 'utf-8'));
                    return accountData.type === accountType;
                } catch (e) {
                    return false;
                }
            } else if (accountType === 'cookie' && file.endsWith('.txt')) {
                return true;
            }
            return false;
        });

        return accountFiles.map(file => {
            if (accountType === 'microsoft') {
                try {
                    const accountData = JSON.parse(fs.readFileSync(path.join(ACCOUNTS_DIR, file), 'utf-8'));
                    return { file, type: accountData.type };
                } catch (e) {
                    return { file, type: 'microsoft' };
                }
            } else if (accountType === 'cookie') {
                return { file, type: 'cookie' };
            }
        });
    }

    static async deleteAccount(file) {
        try {
            const accountFilePath = path.join(ACCOUNTS_DIR, file);
            if (fs.existsSync(accountFilePath)) {
                await fs.promises.unlink(accountFilePath);
                console.log(`Account file ${file} deleted successfully.`);
            } else {
                console.log(`No account file found for ${file}.`);
            }
        } catch (error) {
            console.error(`Error deleting account file ${file}: ${error.message}`);
        }
    }

    static async login(accountObj) {
        const { file, type } = accountObj;
    
        if (type === 'microsoft') {
            return await AccountManager.loginMicrosoft(file);
        } else if (type === 'cookie') {
            const netscapeCookiesPath = path.join(ACCOUNTS_DIR, file);
            if (fs.existsSync(netscapeCookiesPath)) {
                const netscapeCookies = fs.readFileSync(netscapeCookiesPath, 'utf-8');
                console.log(`Found cookies for ${file}`);
                // Keying the proxy pick to this file keeps retries of the same
                // account on the same IP instead of hopping proxies every 5
                // seconds — Microsoft's login risk engine treats a session
                // suddenly appearing from a different IP on every attempt as
                // suspicious and starts demanding an interactive/JS-required
                // sign-in page instead of trusting the cookie.
                return await AccountManager.loginWithCookieAlt(netscapeCookies, `cookie-login:${file}`);
            } else {
                console.log(`No cookie file found for ${file}.`);
                return { success: false, reason: `Cookie file not found: ${file}` };
            }
        } else {
            return { success: false, reason: `Unknown account type: ${type}` };
        }
    }

    static async loginMicrosoft(file) {
        const accountFilePath = path.join(ACCOUNTS_DIR, file);
    
        if (fs.existsSync(accountFilePath)) {
            const accountData = JSON.parse(fs.readFileSync(accountFilePath, 'utf-8'));
    
            if (Date.now() >= accountData.expiresAt) {
                console.log(`Access token for ${file} has expired, refreshing...`);
                const refreshedProfile = await AccountManager.refreshTokens(accountData.refreshToken);
    
                if (refreshedProfile.success) {
                    await AccountManager.storeProfile(refreshedProfile.profile);
                    return { success: true, profile: refreshedProfile.profile };
                } else {
                    return { success: false, reason: refreshedProfile.reason };
                }
            } else {
                console.log(`Access token for ${file} is still valid.`);
                return { success: true, profile: accountData };
            }
        } else {
            console.log(`No account found for ${file}, starting a new login process...`);
            const profileResponse = await AccountManager.startServer();
            if (profileResponse.success) {
                await AccountManager.storeProfile(profileResponse.profile);
                return { success: true, profile: profileResponse.profile };
            } else {
                return { success: false, reason: profileResponse.reason };
            }
        }
    }

    static startServer() {
        return new Promise((resolve) => {
            const app = express();
            app.use(bodyParser.urlencoded({ extended: false }));
    
            const server = app.listen(0, async () => {
                const port = server.address().port;
                const redirectUri = `http://localhost:${port}`;
                const refreshTokenLink = `https://login.live.com/oauth20_authorize.srf?client_id=${CLIENT_ID}&response_type=code&scope=XboxLive.signin%20XboxLive.offline_access&redirect_uri=${encodeURIComponent(redirectUri)}&prompt=select_account`;
    
                const result = await openLoginPage(refreshTokenLink);
                if (!result) {
                    console.error("Failed to open login page.");
                    server.close();
                    return resolve({ success: false, reason: "Failed to open login page." });
                }
    
                const browser = result.browser;
    
                app.get('/', async (req, res) => {
                    const code = req.query.code;
                    if (!code) {
                        res.send("Authentication failed.");
                    } else {
                        try {
                            const profile = await AccountManager.handleCode(code, redirectUri);
                            profile.profile.type = "microsoft";
                            res.send("<html>You may now close this page.<script>window.close()</script></html>");
                            resolve({ success: true, profile: profile.profile });
                        } catch (error) {
                            res.send("Authentication error.");
                            console.error("Error while handling code:", error);
                            resolve({ success: false, reason: error.message });
                        } finally {
                            await browser.close();
                            server.close();
                        }
                    }
                });
    
                browser.on('disconnected', async () => {
                    resolve({ success: false, reason: "Browser was closed before authentication." });
                    server.close();
                });
            });
        });
    }
    
    static createAxiosInstance(proxy) {
        const serverInfo = require('../constants/serverInfo');
        const allowDirect = serverInfo.config?.botSettings?.allowDirectConnect !== false;

        if (!proxy && !allowDirect) {
            throw new Error("No valid proxy available and direct connect is disabled.");
        }

        const config = {
            rejectUnauthorized: false,
            maxHeaderSize: 65536
        };

        if (proxy && proxy.url) {
            const agent = new ProxyAgent(proxy.url);
            config.httpAgent = agent;
            config.httpsAgent = agent;
        }

        return axios.create(config);
    }

    static buildCookieHeader(cookies) {
        return cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
    }

    static async loginCookie(cookieHeader, proxyId = null) {
        try {
            const initialUrl = 'https://sisu.xboxlive.com/connect/XboxLive/?state=login&cobrandId=8058f65d-ce06-4c30-9559-473c9275a65d&tid=896928775&ru=https%3A%2F%2Fwww.minecraft.net%2Fen-us%2Flogin&aid=1142970254';
            const commonHeaders = {
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                'Accept-Encoding': 'gzip, deflate, br',
                'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
                'Cookie': cookieHeader,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36'
            };
    
            const proxy = await ProxyManager.acquireProxy(proxyId);
            const proxyRequest = AccountManager.createAxiosInstance(proxy);
            const dispatcher = buildUndiciDispatcher(proxy);

            // The redirect chain sets session cookies partway through (via Set-Cookie)
            // that later hops depend on. Sending only the original static cookie header
            // to every hop — and ignoring what the server sets along the way — leaves
            // those later hops unauthenticated, so the chain silently redirects around
            // without ever reaching the accessToken URL. Accumulate cookies across hops
            // like a browser would, seeded from the account's own cookies.
            const cookieJar = new Map();
            for (const pair of cookieHeader.split(';')) {
                const eq = pair.indexOf('=');
                if (eq > 0) {
                    const name = pair.slice(0, eq).trim();
                    const value = pair.slice(eq + 1).trim();
                    if (name) cookieJar.set(name, value);
                }
            }
            const jarToHeader = () => Array.from(cookieJar.entries()).map(([n, v]) => `${n}=${v}`).join('; ');

            let currentLocation = initialUrl;
            let finalLocation = null;
            // The MSA cookie -> Xbox -> Minecraft flow is commonly 8-12 redirects, more
            // than the old cap of 6, which cut the chain off before the token.
            const MAX_HOPS = 15;

            for (let step = 1; step <= MAX_HOPS; step++) {
                const hop = await AccountManager.fetchLocation(currentLocation, { ...commonHeaders, Cookie: jarToHeader() }, dispatcher, proxyId);
                if (!hop) {
                    if (currentLocation.includes("accessToken=")) {
                        finalLocation = currentLocation;
                    } else if (step === 2) {
                        return { success: false, reason: "Account is locked" };
                    }
                    break;
                }

                // Merge any cookies the server set on this hop into the jar.
                for (const [name, value] of hop.setCookies) {
                    cookieJar.set(name, value);
                }

                if (!hop.location) {
                    break;
                }

                currentLocation = hop.location;
                if (currentLocation.includes("accessToken=")) {
                    finalLocation = currentLocation;
                    break;
                }
            }

            if (!finalLocation) {
                return { success: false, reason: "Failed to obtain access token redirect (cookies may be expired)" };
            }

            const parsed = AccountManager.parseAccessToken(finalLocation);
            if (!parsed || !parsed.token || !parsed.uhs) {
                return { success: false, reason: "Internal server error while parsing token" };
            }
            const { token, uhs } = parsed;
    
            const tokenRes = await AccountManager.getAccessToken(uhs, token, proxyRequest);
            if (!tokenRes.success) return { success: false, reason: "Failed to fetch java token" };
    
            const gameOwnership = await AccountManager.checkOwnership(tokenRes.data.accessToken, proxyRequest);
            const gameProfile = await AccountManager.getUuidName(tokenRes.data.accessToken, proxyRequest);
    
            if (!gameProfile.success || !gameProfile.data?.name || !gameProfile.data?.uuid) {
                return { success: false, reason: "Account has no active Minecraft Java username/profile" };
            }

            if (!gameOwnership.success || !gameOwnership.data) {
                return { success: false, reason: "Account does not own Minecraft Java Edition" };
            }

            return {
                success: true,
                hasGame: true,
                name: gameProfile.data.name,
                uuid: gameProfile.data.uuid,
                accessToken: tokenRes.data.accessToken,
                expiresAt: tokenRes.data.expiresAt ?? -1
            };
        } catch (error) {
            return { success: false, reason: `loginCookie error: ${error.message}` };
        }
    }
    
    // Parses one hop of the redirect chain. Returns null on a connection failure or a
    // non-redirect response, otherwise { location, setCookies } where setCookies is a
    // list of [name, value] pairs the server set on this hop (to be carried forward).
    //
    // dispatcher is an undici Agent/ProxyAgent built by buildUndiciDispatcher(), not
    // an axios instance. undici is used here (instead of axios/core http, used
    // everywhere else in this file) specifically because its maxHeaderSize is a
    // plain constructor option that isn't bound by Node's process-wide
    // --max-http-header-size flag — the Xbox Live redirect chain routinely returns
    // response headers well past Node's default 16KB limit, and relying on the flag
    // being set correctly wherever this process happens to be launched has proven
    // unreliable in practice.
    static async fetchLocation(url, headers = {}, dispatcher, proxyId = null) {
        let response;
        try {
            response = await undiciRequest(url, {
                headers,
                dispatcher,
                maxRedirections: 0,
                headersTimeout: 20000,
                bodyTimeout: 20000
            });
        } catch (error) {
            console.log(`[AccountManager] fetchLocation failed for ${url.slice(0, 80)}...: ${error.code || error.message}`);
            // This is a connection-level failure (dead proxy, timeout, TLS error) rather
            // than a session/cookie problem. Sticky proxy assignment is meant to stop an
            // account's retries from hopping IPs and looking suspicious to Microsoft, but
            // that only helps if the assigned proxy actually works — a permanently dead
            // proxy would otherwise pin the account to a guaranteed failure forever.
            // Release it so the next retry picks a different one.
            if (proxyId) {
                ProxyManager.releaseProxy(proxyId);
            }
            return null;
        }

        const setCookies = AccountManager.parseSetCookies(response.headers['set-cookie']);

        if (response.statusCode >= 300 && response.statusCode < 400) {
            await response.body.dump().catch(() => {});
            const location = response.headers.location || null;
            console.log(`[AccountManager] hop ${response.statusCode} -> ${location ? location.slice(0, 80) + '...' : '(no location)'}`);
            return { location, setCookies };
        }

        // The generic "cookies may be expired" message that callers fall back to
        // covers up a lot of distinct failure modes (a 2FA/"verify it's you"
        // challenge page, a revoked session, a malformed cookie header, etc). Log
        // what actually came back so those can be told apart instead of always
        // blaming cookie expiry.
        let bodySnippet = '';
        try {
            const text = await response.body.text();
            bodySnippet = text.replace(/\s+/g, ' ').trim().slice(0, 200);
        } catch (e) {}
        console.log(
            `[AccountManager] fetchLocation got a non-redirect response for ${url.slice(0, 80)}...: ` +
            `HTTP ${response.statusCode}${bodySnippet ? ` | body: ${bodySnippet}` : ''}`
        );
        return null;
    }

    // Normalizes undici's set-cookie header (string or array) into [name, value] pairs.
    static parseSetCookies(rawSetCookie) {
        if (!rawSetCookie) return [];
        const list = Array.isArray(rawSetCookie) ? rawSetCookie : [rawSetCookie];
        const pairs = [];
        for (const cookieStr of list) {
            // Only the first "name=value" segment before the first ';' is the cookie itself;
            // the rest are attributes (Path, Domain, Expires, etc.) we don't need here.
            const firstSegment = cookieStr.split(';')[0];
            const eq = firstSegment.indexOf('=');
            if (eq > 0) {
                const name = firstSegment.slice(0, eq).trim();
                const value = firstSegment.slice(eq + 1).trim();
                if (name) pairs.push([name, value]);
            }
        }
        return pairs;
    }

    static async handleCode(code, redirectUri) {
        try {
            const proxy = await ProxyManager.getRandomProxy();
            const proxyRequest = AccountManager.createAxiosInstance(proxy);
        
            const data = {
                client_id: CLIENT_ID,
                redirect_uri: redirectUri,
                grant_type: "authorization_code",
                code: code
            };
        
            const response = await proxyRequest.post(OAUTH20_TOKEN_LINK, qs.stringify(data), {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            });
        
            if (!response.data || !response.data.refresh_token) {
                return { success: false, reason: "Failed to get token." };
            }
        
            const profile = await AccountManager.retrieveGameProfile(response.data.access_token, proxyRequest);
            if (!profile.success) {
                return { success: false, reason: profile.reason };
            }
        
            profile.refreshToken = response.data.refresh_token;
        
            return { success: true, profile: profile };
        } catch (error) {
            console.error("Error in handleCode:", error);
            return { success: false, reason: `handleCode error: ${error.message}` };
        }
    }

    static async refreshTokens(refreshToken) {
        try {
            const proxy = await ProxyManager.getRandomProxy();
            const proxyRequest = AccountManager.createAxiosInstance(proxy);
    
            const data = {
                client_id: CLIENT_ID,
                refresh_token: refreshToken,
                grant_type: "refresh_token"
            };
    
            const response = await proxyRequest.post(OAUTH20_TOKEN_LINK, qs.stringify(data), {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            });
    
            if (!response.data || !response.data.refresh_token || !response.data.access_token) {
                return { success: false, reason: 'Failed to retrieve new access token and refresh token from the response.' };
            }
    
            const profile = await AccountManager.retrieveGameProfile(response.data.access_token, proxyRequest);
            if (!profile.success) {
                return { success: false, reason: profile.reason };
            }
    
            profile.refreshToken = response.data.refresh_token;
    
            return {
                success: true,
                profile: {
                    type: "microsoft",
                    hasGame: profile.hasGame,
                    name: profile.name,
                    uuid: profile.uuid,
                    accessToken: profile.accessToken,
                    expiresAt: profile.expiresAt,
                    refreshToken: profile.refreshToken
                }
            };
        } catch (error) {
            return { success: false, reason: `Error during token refresh: ${error.message}` };
        }
    }

    static async retrieveGameProfile(microsoftToken, proxyRequest) {
        try {
            if (!microsoftToken) {
                return { success: false, reason: "No Microsoft token provided." };
            }
    
            const xblData = await AccountManager.getXboxLiveResponse(microsoftToken, proxyRequest);
            if (!xblData.success) return xblData;
    
            const XSTSToken = await AccountManager.getXstsToken(xblData.data.xblToken, proxyRequest);
            if (!XSTSToken.success) return XSTSToken;
    
            const tokenRes = await AccountManager.getAccessToken(xblData.data.userHash, XSTSToken.data, proxyRequest);
            if (!tokenRes.success) return tokenRes;
    
            const gameOwnership = await AccountManager.checkOwnership(tokenRes.data.accessToken, proxyRequest);
            const gameProfile = await AccountManager.getUuidName(tokenRes.data.accessToken, proxyRequest);
    
            return {
                success: gameOwnership.success && gameOwnership.data && gameProfile.data?.name != null && gameProfile.data?.uuid != null && tokenRes.data.accessToken != null,
                hasGame: gameOwnership.data ?? false,
                name: gameProfile.data?.name ?? null,
                uuid: gameProfile.data?.uuid ?? null,
                accessToken: tokenRes.data.accessToken ?? null,
                expiresAt: tokenRes.data.expiresAt ?? -1
            };
        } catch (error) {
            return { success: false, reason: `retrieveGameProfile error: ${error.message}` };
        }
    }

    static async getXboxLiveResponse(accessToken, proxyRequest) {
        try {
            const body = {
                Properties: { AuthMethod: "RPS", SiteName: "user.auth.xboxlive.com", RpsTicket: "d=" + accessToken },
                RelyingParty: "http://auth.xboxlive.com",
                TokenType: "JWT"
            };
            const response = await proxyRequest.post(XBL_LINK, body);
            return { success: true, data: { xblToken: response.data.Token, userHash: response.data.DisplayClaims.xui[0].uhs } };
        } catch (error) {
            return { success: false, reason: `getXboxLiveResponse error: ${error.message}`, code: error.code };
        }
    }

    static async getXstsToken(xblToken, proxyRequest) {
        try {
            const body = {
                Properties: { SandboxId: "RETAIL", UserTokens: [xblToken] },
                RelyingParty: "rp://api.minecraftservices.com/",
                TokenType: "JWT"
            };
            const response = await proxyRequest.post(XSTS_LINK, body);
            return { success: true, data: response.data.Token };
        } catch (error) {
            return { success: false, reason: `getXstsToken error: ${error.message}`, code: error.code };
        }
    }

    static async getAccessToken(userHash, xstsToken, proxyRequest) {
        try {
            const body = { "identityToken": `XBL3.0 x=${userHash};${xstsToken}` };
            const response = await proxyRequest.post(MC_SERVICES_LINK, body, { headers: { 'Content-Type': 'application/json' } });
            return { success: true, data: { accessToken: response.data.access_token, expiresAt: Date.now() + response.data.expires_in * 1000 } };
        } catch (error) {
            return { success: false, reason: `getAccessToken error: ${error.message}`, code: error.code };
        }
    }

    static async checkOwnership(javaToken, proxyRequest) {
        try {
            const headers = { 'Authorization': `Bearer ${javaToken}` };
            const gameOwnershipResponse = await proxyRequest.get(OWNERSHIP_LINK, { headers });
            const hasGameOwnership = AccountManager.hasGameOwnership(gameOwnershipResponse.data.items);
            return { success: true, data: hasGameOwnership };
        } catch (error) {
            return { success: false, reason: `checkOwnership error: ${error.message}`, code: error.code };
        }
    }

    static async getUuidName(javaToken, proxyRequest) {
        try {
            const headers = { 'Authorization': `Bearer ${javaToken}` };
            const profileResponse = await proxyRequest.get(PROFILE_LINK, { headers });
            return { success: true, data: { uuid: profileResponse.data.id, name: profileResponse.data.name } };
        } catch (error) {
            return { success: false, reason: `getUuidName error: ${error.message}`, code: error.code };
        }
    }

    static hasGameOwnership(items) {
        let hasProduct = false;
        let hasGame = false;
        for (let item of items) {
            if (item.name === "product_minecraft") hasProduct = true;
            else if (item.name === "game_minecraft") hasGame = true;
        }
        return hasProduct && hasGame;
    }

    static async storeProfile(profile) {
        if (!fs.existsSync(ACCOUNTS_DIR)) {
            fs.mkdirSync(ACCOUNTS_DIR);
        }
    
        if (profile.hasOwnProperty('success')) {
            delete profile.success;
        }
    
        const filePath = path.join(ACCOUNTS_DIR, `${profile.name}.json`);
        await fs.promises.writeFile(filePath, JSON.stringify(profile, null, 4), 'utf-8');
    }

    static async loginWithCookieAlt(netscapeCookies, proxyId = null) {
        try {
            const cookies = AccountManager.parseNETSCAPEFile(netscapeCookies);
            const cookieHeader = AccountManager.buildCookieHeader(cookies);
            const tokenData = await AccountManager.loginCookie(cookieHeader, proxyId);
            if (tokenData.success) {
                return { success: true, profile: tokenData };
            } else {
                return { success: false, reason: tokenData.reason };
            }
        } catch (error) {
            console.error(error);
            return { success: false, reason: `loginWithCookieAlt error: ${error.message}` };
        }
    }
    static parseAccessToken(url) {
        const accessTokenHash = url.split("accessToken=")[1];
        if (accessTokenHash) {
            const decoded = utf8.decode(base64.decode(accessTokenHash)).split('"rp://api.minecraftservices.com/",')[1];
            const token = decoded.split('"Token":"')[1].split('"')[0];
            const uhs = decoded.split('{"DisplayClaims":{"xui":[{"uhs":"')[1].split('"')[0];
            return { token, uhs };
        }
        return null;
    }

    static parseNETSCAPEFile(netscapeCookies) {
        let lines = netscapeCookies.split(/\r\n|\n/);
        let cookies = [];

        for (let line of lines) {
            let parts = line.split('\t').map(part => part.trim());

            if (parts.length !== 7 || parts[0].startsWith('#')) continue;

            let [domain, , path, secureFlag, expires, name, value] = parts;

            if (domain.charCodeAt(0) === 0xFEFF) {
                domain = domain.slice(1);
            }
            domain = domain.replace(/[^\x20-\x7E]/g, '');

            let cookie = {
                domain,
                path,
                secure: secureFlag.toLowerCase() === 'true',
                name,
                value,
                sameSite: 'Lax'
            };

            if (cookie.name.startsWith('__Host-')) {
                cookie.secure = true;
            }

            if (expires !== "0") {
                let expirationDate = parseInt(expires, 10);
                if (!isNaN(expirationDate)) {
                    cookie.expires = expirationDate * 1000;
                }
            }

            if (cookie.sameSite === 'Norestriction') {
                cookie.sameSite = 'None';
            }

            cookies.push(cookie);
        }
        return cookies;
    }
}

async function openLoginPage(url) {
    const proxy = await ProxyManager.getRandomProxy();
    const serverInfo = require('../constants/serverInfo');
    const allowDirect = serverInfo.config?.botSettings?.allowDirectConnect !== false;

    if (!proxy && !allowDirect) {
        console.error('No valid proxies available and direct connect is disabled.');
        return null;
    }

    let browser;

    try {
        const puppeteerArgs = ['--window-size=800,690'];
        if (proxy) {
            puppeteerArgs.push(`--proxy-server=${proxy.host}:${proxy.port}`);
        }

        browser = await puppeteer.launch({
            headless: false,
            args: puppeteerArgs
        });

        const page = await browser.newPage();

        if (proxy && proxy.username && proxy.password) {
            await page.authenticate({
                username: proxy.username,
                password: proxy.password
            });
        }

        await page.goto(url);

        return { browser, page };
    } catch (err) {
        console.error('Error during page setup or navigation:', err);
        
        if (browser) {
            await browser.close();
        }

        return null;
    }
}

module.exports = AccountManager;