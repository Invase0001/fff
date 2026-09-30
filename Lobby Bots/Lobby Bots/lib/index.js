process.emitWarning = () => {};
require('dotenv').config();

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');

function ensureConfigFile() {
    if (fs.existsSync(CONFIG_PATH)) return;

    const examplePath = path.join(__dirname, 'config.example.json');
    if (fs.existsSync(examplePath)) {
        fs.copyFileSync(examplePath, CONFIG_PATH);
        return;
    }

    const defaultConfig = {
        discord: {
            token: "",
            clientId: "",
            guildId: "",
            chatChannelId: "",
            eventsChannelId: "",
            statusChannelId: ""
        },
        hypixel: {
            host: "mc.hypixel.net",
            port: 25565,
            version: "1.8.9",
            targetLobbyCommand: "/lobby bedwars"
        },
        botSettings: {
            allowDirectConnect: true,
            antiAfkIntervalSec: 25,
            limboCheckIntervalSec: 15,
            joinLeaveBatchWindowMs: 4000
        }
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig, null, 2));
}

// Must run before any local module is required below: ./src/functions/mineflayer
// pulls in ./src/constants/serverInfo, which reads config.json at require-time
// (module load), not lazily. On a fresh install that require would otherwise
// run before this file existed, so it would permanently cache an empty config
// for the process's whole lifetime even though config.json gets created a few
// lines later — the app would silently ignore hypixel/botSettings overrides
// until it was restarted a second time.
ensureConfigFile();

const AccountManager = require('./src/utils/AccountManager');
const ProxyManager = require('./src/utils/ProxyManager');
const { startAPI, stopAPI } = require('./src/utils/BotAPI');
const { stopBots } = require('./src/functions/mineflayer');
const DiscordService = require('./src/discord/client');

function loadConfig() {
    try {
        return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (e) {
        console.error(`Error loading config.json: ${e.message}`);
        return {};
    }
}

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception (process will exit):', err);
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled promise rejection:', reason);
});

async function main() {
    const chalk = (await import('chalk')).default;

    console.log(chalk.cyan('=================================================='));
    console.log(chalk.bold.yellow('   Hypixel Bedwars Lobby Watcher Bot Framework    '));
    console.log(chalk.cyan('=================================================='));

    // 1. Ensure required folders and files exist
    AccountManager.ensureAccountsDir();
    ProxyManager.loadProxies();

    // 2. Load configuration
    const config = loadConfig();

    // 3. Start local Fastify REST API
    try {
        startAPI();
    } catch (err) {
        console.warn(`[BotAPI] Could not start REST API: ${err.message}`);
    }

    
    let discordService = null;

    const discordToken = config.discord?.token || process.env.DISCORD_TOKEN;
    if (discordToken && discordToken !== "YOUR_DISCORD_BOT_TOKEN") {
        config.discord = config.discord || {};
        config.discord.token = discordToken;
        config.discord.clientId = config.discord.clientId || process.env.DISCORD_CLIENT_ID;
        config.discord.guildId = config.discord.guildId || process.env.DISCORD_GUILD_ID;

        discordService = new DiscordService(config);
        const started = await discordService.init();

        if (started) {
            console.log(chalk.green('✓ Discord Bot successfully connected and listening for slash commands!'));
            console.log(chalk.gray('  Commands available: /accounts, /proxies, /connect, /disconnect, /status'));
        }
    } else {
        console.log(chalk.yellow('\n[Notice] No Discord Bot Token configured.'));
        console.log(chalk.yellow('To enable Discord slash commands and channel notifications:'));
        console.log(chalk.white(`1. Open `) + chalk.cyan('lib/config.json'));
        console.log(chalk.white('2. Set your `token`, `clientId`, `chatChannelId`, and `eventsChannelId`.'));
        console.log(chalk.white('3. Restart the application with `npm start`.\n'));
    }
 
    let shuttingDown = false;
    const shutdown = async () => {
        if (shuttingDown) return;
        shuttingDown = true;

        console.log(chalk.yellow('\nShutting down Lobby Bots...'));
        try {
            await stopBots();
        } catch (err) {
            console.error('Error while stopping bots:', err);
        }

        try {
            await stopAPI();
        } catch (err) {
            console.error('Error while stopping REST API:', err);
        }

        if (discordService?.client) {
            try {
                await discordService.client.destroy();
            } catch (err) {
                console.error('Error while disconnecting Discord client:', err);
            }
        }

        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch(err => {
    console.error('Fatal startup error:', err);
    process.exit(1);
});