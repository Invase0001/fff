process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
process.emitWarning = () => {};

const mineflayer = require("mineflayer");
const server = require('../constants/serverInfo');
const socks = require('socks').SocksClient;
const ProxyAgent = require('proxy-agent');
const ProxyManager = require('../utils/ProxyManager');
const AccountManager = require('../utils/AccountManager');
const { addBot, removeBot, updateBot } = require('../utils/BotAPI');
const { setupLobbyWatcher } = require('./lobbyWatcher');
const LobbyCoordinator = require('../utils/LobbyCoordinator');
const http = require('http');

function createHttpConnectSocket(proxy, destination, callback) {
    const authHeader = (proxy.username && proxy.password)
        ? { 'Proxy-Authorization': 'Basic ' + Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64') }
        : {};

    const req = http.request({
        host: proxy.host,
        port: proxy.port,
        method: 'CONNECT',
        path: `${destination.host}:${destination.port}`,
        headers: {
            Host: `${destination.host}:${destination.port}`,
            ...authHeader
        }
    });

    req.on('connect', (res, socket) => {
        if (res.statusCode === 200) {
            callback(null, socket);
        } else {
            callback(new Error(`HTTP Proxy CONNECT failed: status ${res.statusCode}`));
        }
    });

    req.on('error', (err) => {
        callback(err);
    });

    req.end();
}

const activeBots = [];
const activeTimeouts = new Set();
let isShuttingDown = false;
let globalDiscordService = null;
let lobbyCheckTimer = null;

function setDiscordService(discordService) {
    globalDiscordService = discordService;
}

function getActiveBots() {
    return activeBots.map(b => {
        const assigned = b.watcher ? b.watcher.getAssignedLobby() : LobbyCoordinator.getAssignedLobby(b.accountName || b.uuid);
        const currentLobby = b.watcher ? b.watcher.getCurrentLobby() : 'Connecting...';
        return {
            name: b.bot?.username || b.accountName,
            uuid: b.uuid,
            assignedLobby: assigned,
            lobby: currentLobby,
            connectedAt: b.connectedAt
        };
    });
}

// Every 5 minutes, ask each active bot's watcher whether it's actually sitting
// in its assigned Bedwars lobby. Any bot that drifted (e.g. got swapped by
// another player, or silently missed a route command) gets re-routed here.
function startLobbyCheckWatchdog() {
    if (lobbyCheckTimer) return;

    lobbyCheckTimer = setInterval(async () => {
        if (isShuttingDown || activeBots.length === 0) return;

        const chalk = (await import('chalk')).default;
        const mismatches = [];

        for (const record of activeBots) {
            if (!record.watcher || !record.watcher.verifyAndCorrectLobby) continue;
            const result = record.watcher.verifyAndCorrectLobby();
            if (!result.ok) {
                mismatches.push(`${record.accountName} (expected #${result.assignedLobby}, in ${result.currentLobby})`);
            }
        }

        if (mismatches.length > 0) {
            console.log(chalk.gray('[') + chalk.green('Autobot') + chalk.gray('] ') + chalk.yellow(`5-minute lobby check: re-routing ${mismatches.length} bot(s) off target: `) + chalk.red(mismatches.join(', ')));

            if (globalDiscordService && globalDiscordService.sendStatusEmbed) {
                globalDiscordService.sendStatusEmbed({
                    title: 'Lobby check found bots off target',
                    description: mismatches.map(m => `- ${m}`).join('\n'),
                    color: 0x6B4A1E
                });
            }
        }
    }, 5 * 60 * 1000);
}

function stopLobbyCheckWatchdog() {
    if (lobbyCheckTimer) {
        clearInterval(lobbyCheckTimer);
        lobbyCheckTimer = null;
    }
}

async function startBot(accountObj) {
    if (isShuttingDown) return;

    const chalk = (await import('chalk')).default;

    const validatedAccount = await AccountManager.login(accountObj);
    if (!validatedAccount || !validatedAccount.success || !validatedAccount.profile) {
        if (accountObj.type === "cookie" && validatedAccount?.reason?.includes("Account is locked")) {
            AccountManager.deleteAccount(accountObj.file);
            console.log(chalk.gray('[') + chalk.green('Autobot') + chalk.gray('] ') + chalk.green(accountObj.file) + chalk.yellow(' is ') + chalk.red("locked") + chalk.yellow('. Removing account.'));
            return;
        }

        console.log(chalk.gray('[') + chalk.green('Autobot') + chalk.gray('] ') + chalk.yellow(`Failed to login to `) + chalk.green(accountObj.file) + chalk.yellow(`.`) + chalk.red(` ${validatedAccount?.reason || 'Unknown error'}`));
        return;
    }

    const account = validatedAccount.profile;
    if (!account || !account.name || !account.uuid) {
        console.log(chalk.gray('[') + chalk.green('Autobot') + chalk.gray('] ') + chalk.red(`Skipping ${accountObj.file}: Account has no valid Minecraft username or profile.`));
        return;
    }

    const assignedLobby = LobbyCoordinator.acquireLobby(account.name, account.uuid);
    if (!assignedLobby) {
        console.log(chalk.gray('[') + chalk.green('Autobot') + chalk.gray('] ') + chalk.yellow(`All 18 Bedwars lobby slots are occupied. Skipping `) + chalk.green(account.name));
        return;
    }
    console.log(chalk.gray('[') + chalk.green('Autobot') + chalk.gray('] ') + chalk.yellow(`Assigned `) + chalk.green(account.name) + chalk.yellow(` to `) + chalk.cyan(`Bedwars Lobby #${assignedLobby}`));

    if (accountObj.type === "microsoft" && account.name.startsWith("random")) {
        accountObj.file = `${account.name}.json`;
    }

    const proxy = await ProxyManager.acquireProxy(account.uuid || account.name);
    const allowDirect = server.config?.botSettings?.allowDirectConnect !== false;

    if (!proxy && !allowDirect) {
        console.log(chalk.gray('[') + chalk.green('Autobot') + chalk.gray('] ') + chalk.yellow(`No proxies available and direct connect is disabled.`));
        return;
    }

    let restartInitiated = false;

    const customAuth = (client, opts) => {
        client.session = opts.session;
        client.username = opts.session.selectedProfile.name;
        opts.accessToken = opts.session.accessToken;
        opts.haveCredentials = true;
        client.emit('session', opts.session);
        opts.connect(client);
    };

    const botOptions = {
        host: server.host,
        username: account.name,
        port: server.port,
        version: server.version,
        viewDistance: server.viewDistance,
        auth: customAuth,
        skipValidation: true,
        session: {
            accessToken: account.accessToken,
            clientToken: account.uuid,
            selectedProfile: {
                id: account.uuid,
                name: account.name
            }
        }
    };

    if (proxy) {
        console.log(chalk.gray('[') + chalk.green('Autobot') + chalk.gray('] ') + chalk.yellow(`Connecting ${account.name} via proxy ${proxy.host}:${proxy.port} (${proxy.protocol || 'socks5'})`));
        botOptions.agent = new ProxyAgent(proxy.url);
        botOptions.connect = (client) => {
            if (proxy.protocol && proxy.protocol.startsWith('http')) {
                createHttpConnectSocket(proxy, { host: server.host, port: server.port }, (err, socket) => {
                    if (err) {
                        console.log(chalk.gray('[') + chalk.green('Autobot') + chalk.gray('] ') + chalk.yellow(`${account.name} HTTP proxy connection error: `) + chalk.red(err.message));
                        scheduleRestart(accountObj);
                        return;
                    }
                    client.setSocket(socket);
                    client.emit('connect');
                });
            } else {
                const proxyConfig = {
                    host: proxy.host,
                    port: proxy.port,
                    type: 5
                };
                if (proxy.username) proxyConfig.userId = proxy.username;
                if (proxy.password) proxyConfig.password = proxy.password;

                socks.createConnection({
                    proxy: proxyConfig,
                    command: 'connect',
                    destination: {
                        host: server.host,
                        port: server.port
                    }
                }, (err, info) => {
                    if (err) {
                        console.log(chalk.gray('[') + chalk.green('Autobot') + chalk.gray('] ') + chalk.yellow(`${account.name} proxy connection error: `) + chalk.red(err.message));
                        scheduleRestart(accountObj);
                        return;
                    }
                    client.setSocket(info.socket);
                    client.emit('connect');
                });
            }
        };
    } else {
        console.log(chalk.gray('[') + chalk.green('Autobot') + chalk.gray('] ') + chalk.yellow(`Connecting ${account.name} directly (no proxy)`));
    }

    let bot;
    try {
        bot = mineflayer.createBot(botOptions);
    } catch (createErr) {
        console.log(chalk.gray('[') + chalk.green('Autobot') + chalk.gray('] ') + chalk.red(`Failed to create bot: ${createErr.message}`));
        scheduleRestart(accountObj);
        return;
    }

    const botRecord = {
        bot,
        accountName: account.name,
        uuid: account.uuid,
        connectedAt: Date.now(),
        watcher: null
    };
    activeBots.push(botRecord);

    const watcher = setupLobbyWatcher(bot, account.name, globalDiscordService, server.config, assignedLobby);
    botRecord.watcher = watcher;

    function scheduleRestart(acc) {
        if (isShuttingDown || restartInitiated) return;
        restartInitiated = true;
        const timer = setTimeout(() => {
            activeTimeouts.delete(timer);
            startBot(acc);
        }, 5000);
        activeTimeouts.add(timer);
    }

    function removeBotFromPool() {
        const index = activeBots.findIndex(b => b.bot === bot);
        if (index > -1) {
            activeBots.splice(index, 1);
        }
        LobbyCoordinator.releaseLobby(account.uuid);
        ProxyManager.releaseProxy(account.uuid || account.name);
    }

    bot.once("spawn", async () => {
        console.log(chalk.gray('[') + chalk.green('Autobot') + chalk.gray('] ') + chalk.yellow(`${account.name} logged into `) + chalk.green(server.host) + chalk.yellow(` (Lobby #${assignedLobby}).`));
        addBot({
            uuid: account.uuid,
            name: account.name,
            location: null
        });

        if (globalDiscordService && globalDiscordService.sendStatusEmbed) {
            globalDiscordService.sendStatusEmbed({
                title: "✅ Bot Connected",
                description: `**${account.name}** connected to **${server.host}** (Target: \`Lobby #${assignedLobby}\`)`,
                color: 0x2ECC71
            });
        }
    });

    bot.on("message", async (chatMsg) => {
        const msg = chatMsg.toString();
        if (msg.startsWith("{") && msg.endsWith("}")) {
            try {
                const locraw = JSON.parse(msg);
                updateBot(account.uuid, { location: locraw });
            } catch (e) {}
        }
    });

    bot.on("end", async (reason) => {
        removeBot(account.uuid);
        removeBotFromPool();

        if (isShuttingDown) return;

        await sleep(2000);
        console.log(chalk.gray('[') + chalk.green('Autobot') + chalk.gray('] ') + chalk.yellow(`${account.name} disconnected: `) + chalk.red(reason));
        scheduleRestart(accountObj);
    });

    bot.on('kicked', async (reason) => {
        removeBot(account.uuid);
        removeBotFromPool();

        const reasonStr = typeof reason === 'string' ? reason : JSON.stringify(reason);
        if (reasonStr.toLowerCase().includes("banned")) {
            console.log(chalk.gray('[') + chalk.green('Autobot') + chalk.gray('] ') + chalk.green(account.name) + chalk.yellow(' was banned for ') + chalk.red(getBanReason(reasonStr)) + chalk.yellow('. Removing account and proxy.'));
            AccountManager.deleteAccount(accountObj.file);
            if (proxy && proxy.string) {
                ProxyManager.removeProxy(proxy.string);
            }
            if (globalDiscordService && globalDiscordService.sendStatusEmbed) {
                globalDiscordService.sendStatusEmbed({
                    title: "⚠️ Bot Banned",
                    description: `**${account.name}** was banned: ${getBanReason(reasonStr)}. Account deleted.`,
                    color: 0xE74C3C
                });
            }
            return;
        }

        console.log(chalk.gray('[') + chalk.green('Autobot') + chalk.gray('] ') + chalk.yellow(`${account.name} was kicked: `) + chalk.red(reasonStr));

        if (!isShuttingDown) {
            scheduleRestart(accountObj);
        }
    });

    bot.on("error", async (err) => {
        removeBotFromPool();
        removeBot(account.uuid);

        console.log(chalk.gray('[') + chalk.green('Autobot') + chalk.gray('] ') + chalk.red(`${account.name || 'Bot'} error: ${err.message}`));

        if (!isShuttingDown && err.code !== "ERR_INVALID_ARG_TYPE") {
            scheduleRestart(accountObj);
        }
    });
}

async function startBots(accountsList, discordService = null) {
    if (discordService) {
        setDiscordService(discordService);
    }
    isShuttingDown = false;
    const maxLobbies = server.config?.botSettings?.maxBedwarsLobbies || 18;
    const targetAccounts = accountsList.slice(0, maxLobbies);
    startLobbyCheckWatchdog();

    // Stagger login kickoff instead of firing every account's OAuth request in the
    // same instant — on top of the round-robin proxy picks in ProxyManager, this
    // avoids a synchronized burst of login traffic that can read as bot activity
    // to Microsoft's login endpoint and trigger rate limiting.
    const staggerMs = server.config?.botSettings?.loginStaggerMs ?? 400;
    const launches = targetAccounts.map((acc, i) => new Promise((resolve) => {
        const timer = setTimeout(() => {
            activeTimeouts.delete(timer);
            startBot(acc).finally(resolve);
        }, i * staggerMs);
        activeTimeouts.add(timer);
    }));

    await Promise.all(launches);
}

async function stopBots() {
    isShuttingDown = true;
    stopLobbyCheckWatchdog();

    for (const timer of activeTimeouts) {
        clearTimeout(timer);
    }
    activeTimeouts.clear();

    const count = activeBots.length;
    for (const record of [...activeBots]) {
        try {
            if (record.watcher) record.watcher.cleanup();
            if (record.bot) {
                record.bot.quit('Stopped by user command');
            }
            removeBot(record.uuid);
        } catch (e) {}
    }
    activeBots.length = 0;
    LobbyCoordinator.clear();
    ProxyManager.clearAssignments();

    return count;
}

function getBanReason(kick) {
    const lower = kick.toLowerCase();
    if (lower.includes("suspicious") || lower.includes("security")) {
        return "Suspicious Activity";
    } else if (lower.includes("boosting")) {
        return "Boosting";
    } else if (lower.includes("cheating")) {
        return "Cheating";
    } else {
        return kick;
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
    startBots,
    stopBots,
    startBot,
    getActiveBots,
    setDiscordService,
    LobbyCoordinator
};