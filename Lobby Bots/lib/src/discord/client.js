const {
    Client,
    GatewayIntentBits,
    SlashCommandBuilder,
    REST,
    Routes,
    EmbedBuilder
} = require('discord.js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const AccountManager = require('../utils/AccountManager');
const ProxyManager = require('../utils/ProxyManager');
const TrackerDB = require('../utils/TrackerDB');
const LobbyCoordinator = require('../utils/LobbyCoordinator');
const NotifySettings = require('../utils/NotifySettings');
const { startBots, stopBots, getActiveBots, setDiscordService } = require('../functions/mineflayer');

class DiscordService {
    constructor(config) {
        this.config = config;
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages
            ]
        });

        this.chatChannel = null;
        this.eventsChannel = null;
        this.statusChannel = null;
    }

    async init() {
        const token = this.config.discord?.token;
        const clientId = this.config.discord?.clientId;

        if (!token || token === "YOUR_DISCORD_BOT_TOKEN") {
            console.log("[Discord] No bot token provided in config.json. Discord bot will not start.");
            return false;
        }

        this.registerEventHandlers();
        await this.client.login(token);

        if (clientId && clientId !== "YOUR_DISCORD_CLIENT_ID") {
            await this.registerSlashCommands(token, clientId, this.config.discord?.guildId);
        }

        setDiscordService(this);
        return true;
    }

    async registerSlashCommands(token, clientId, guildId) {
        const commands = [
            new SlashCommandBuilder()
                .setName('accounts')
                .setDescription('Upload a .zip file containing cookie .txt files')
                .addAttachmentOption(opt =>
                    opt.setName('file')
                        .setDescription('The .zip archive of cookie .txt accounts')
                        .setRequired(true)
                ),

            new SlashCommandBuilder()
                .setName('proxies')
                .setDescription('Upload a .txt file containing proxies (host:port:user:pass or host:port)')
                .addAttachmentOption(opt =>
                    opt.setName('file')
                        .setDescription('The proxies .txt file')
                        .setRequired(true)
                ),

            new SlashCommandBuilder()
                .setName('connect')
                .setDescription('Start the Bedwars lobby watcher bots (1 bot per lobby)')
                .addIntegerOption(opt =>
                    opt.setName('count')
                        .setDescription('Number of bots to connect (1-18, 1 per Bedwars lobby)')
                        .setRequired(false)
                        .setMinValue(1)
                        .setMaxValue(18)
                ),

            new SlashCommandBuilder()
                .setName('disconnect')
                .setDescription('Stop and disconnect all running bots'),

            new SlashCommandBuilder()
                .setName('status')
                .setDescription('View currently active bots, lobbies, and proxy status'),

            new SlashCommandBuilder()
                .setName('track')
                .setDescription('Manage players to watch in Bedwars lobbies')
                .addSubcommand(sub =>
                    sub.setName('add')
                        .setDescription('Add a player to track')
                        .addStringOption(opt =>
                            opt.setName('username')
                                .setDescription('Minecraft username to track')
                                .setRequired(true)
                        )
                        .addStringOption(opt =>
                            opt.setName('note')
                                .setDescription('Optional note or reason for tracking')
                                .setRequired(false)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('remove')
                        .setDescription('Remove a player from tracking')
                        .addStringOption(opt =>
                            opt.setName('username')
                                .setDescription('Minecraft username to remove')
                                .setRequired(true)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('list')
                        .setDescription('List all currently tracked players')
                )
                .addSubcommand(sub =>
                    sub.setName('clear')
                        .setDescription('Clear all tracked players from the database')
                ),

            new SlashCommandBuilder()
                .setName('tm')
                .setDescription('Set the role mentioned when a tracked player joins a lobby')
                .addRoleOption(opt =>
                    opt.setName('role')
                        .setDescription('Role to mention on tracked player joins (omit to turn off)')
                        .setRequired(false)
                )
        ].map(cmd => cmd.toJSON());

        const rest = new REST({ version: '10' }).setToken(token);

        try {
            console.log('[Discord] Refreshing application (/) slash commands...');

            if (guildId && guildId.trim()) {
                await rest.put(
                    Routes.applicationGuildCommands(clientId, guildId.trim()),
                    { body: commands }
                );
                console.log(`[Discord] Successfully registered guild slash commands for guild ${guildId}.`);
            } else {
                await rest.put(
                    Routes.applicationCommands(clientId),
                    { body: commands }
                );
                console.log('[Discord] Successfully registered global slash commands.');
            }
        } catch (error) {
            console.error('[Discord] Error registering slash commands:', error);
        }
    }

    registerEventHandlers() {
        this.client.once('ready', async () => {
            console.log(`[Discord] Logged in as ${this.client.user.tag}!`);

            // Cache configured channels
            if (this.config.discord?.chatChannelId) {
                try {
                    this.chatChannel = await this.client.channels.fetch(this.config.discord.chatChannelId);
                } catch (e) {
                    console.error(`[Discord] Could not fetch chat channel: ${e.message}`);
                }
            }

            if (this.config.discord?.eventsChannelId) {
                try {
                    this.eventsChannel = await this.client.channels.fetch(this.config.discord.eventsChannelId);
                } catch (e) {
                    console.error(`[Discord] Could not fetch events channel: ${e.message}`);
                }
            }

            if (this.config.discord?.statusChannelId) {
                try {
                    this.statusChannel = await this.client.channels.fetch(this.config.discord.statusChannelId);
                } catch (e) {
                    console.error(`[Discord] Could not fetch status channel: ${e.message}`);
                }
            }
        });

        this.client.on('interactionCreate', async (interaction) => {
            if (!interaction.isChatInputCommand()) return;

            const { commandName } = interaction;

            try {
                if (commandName === 'accounts') {
                    await this.handleAccountsCommand(interaction);
                } else if (commandName === 'proxies') {
                    await this.handleProxiesCommand(interaction);
                } else if (commandName === 'connect') {
                    await this.handleConnectCommand(interaction);
                } else if (commandName === 'disconnect') {
                    await this.handleDisconnectCommand(interaction);
                } else if (commandName === 'status') {
                    await this.handleStatusCommand(interaction);
                } else if (commandName === 'track') {
                    await this.handleTrackCommand(interaction);
                } else if (commandName === 'tm') {
                    await this.handleTmCommand(interaction);
                }
            } catch (err) {
                console.error(`[Discord] Error executing /${commandName}:`, err);
                const replyFn = interaction.deferred || interaction.replied ? 'editReply' : 'reply';
                await interaction[replyFn]({
                    content: `Error running /${commandName}: ${err.message}`,
                    ephemeral: true
                }).catch(() => {});
            }
        });
    }

    // --- Slash Command Handlers ---

    async handleAccountsCommand(interaction) {
        await interaction.deferReply();
        const attachment = interaction.options.getAttachment('file');

        if (!attachment || !attachment.name.toLowerCase().endsWith('.zip')) {
            return interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setColor(0x8B2E2E)
                        .setTitle('Invalid file format')
                        .setDescription('Attach a `.zip` file containing your cookie `.txt` accounts.')
                ]
            });
        }

        try {
            const response = await axios.get(attachment.url, { responseType: 'arraybuffer' });
            const importedCount = AccountManager.importAccountsFromZip(Buffer.from(response.data));

            const totalCookie = AccountManager.loadAccountsByType('cookie').length;
            const totalMicrosoft = AccountManager.loadAccountsByType('microsoft').length;

            const embed = new EmbedBuilder()
                .setColor(0x2F4F3E)
                .setTitle('Accounts imported')
                .setDescription(`Imported **${importedCount}** account file(s) from \`${attachment.name}\`.`)
                .addFields(
                    { name: 'Cookie accounts', value: `${totalCookie}`, inline: true },
                    { name: 'Microsoft accounts', value: `${totalMicrosoft}`, inline: true }
                )
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });
        } catch (err) {
            await interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setColor(0x8B2E2E)
                        .setTitle('Extraction error')
                        .setDescription(`Failed to extract accounts: ${err.message}`)
                ]
            });
        }
    }

    async handleProxiesCommand(interaction) {
        await interaction.deferReply();
        const attachment = interaction.options.getAttachment('file');

        if (!attachment || !attachment.name.toLowerCase().endsWith('.txt')) {
            return interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setColor(0x8B2E2E)
                        .setTitle('Invalid file format')
                        .setDescription('Attach a `.txt` file containing your proxies.')
                ]
            });
        }

        try {
            const response = await axios.get(attachment.url, { responseType: 'text' });
            const proxyText = response.data;

            const loadedCount = ProxyManager.importProxiesFromText(proxyText);

            await interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setColor(0x6B4A1E)
                        .setTitle('Validating proxies')
                        .setDescription(`Loaded **${loadedCount}** proxies. Checking each against test endpoints...`)
                ]
            });

            const { working, failed } = await ProxyManager.validateAllProxies();

            const embed = new EmbedBuilder()
                .setColor(working.length > 0 ? 0x2F4F3E : 0x8B2E2E)
                .setTitle('Proxy validation complete')
                .addFields(
                    { name: 'Working', value: `${working.length}`, inline: true },
                    { name: 'Failed', value: `${failed.length}`, inline: true },
                    { name: 'Total loaded', value: `${loadedCount}`, inline: true }
                )
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });
        } catch (err) {
            await interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setColor(0x8B2E2E)
                        .setTitle('Proxy import error')
                        .setDescription(`Failed to process proxies: ${err.message}`)
                ]
            });
        }
    }

    async handleConnectCommand(interaction) {
        await interaction.deferReply();

        const active = getActiveBots();
        if (active.length > 0) {
            return interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setColor(0x6B4A1E)
                        .setTitle('Bots already active')
                        .setDescription(`**${active.length}** bots are already running. Use \`/disconnect\` first to restart.`)
                ]
            });
        }

        let accounts = AccountManager.loadAccountsByType('cookie');
        if (accounts.length === 0) {
            accounts = AccountManager.loadAccountsByType('microsoft');
        }

        if (accounts.length === 0) {
            return interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setColor(0x8B2E2E)
                        .setTitle('No accounts available')
                        .setDescription('No accounts found in `lib/accounts/`. Upload a `.zip` of cookie accounts with `/accounts`.')
                ]
            });
        }

        const maxLobbies = this.config.botSettings?.maxBedwarsLobbies || 18;
        const requestedCount = interaction.options.getInteger('count');
        const effectiveCap = Math.min(accounts.length, maxLobbies);
        const countToUse = requestedCount ? Math.min(requestedCount, effectiveCap) : effectiveCap;
        const selectedAccounts = accounts.slice(0, countToUse);

        const proxies = ProxyManager.loadProxies();
        const allowDirect = this.config.botSettings?.allowDirectConnect !== false;

        if (proxies.length === 0 && !allowDirect) {
            return interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setColor(0x8B2E2E)
                        .setTitle('No proxies available')
                        .setDescription('Direct connect is disabled and no proxies were found. Upload proxies with `/proxies` or enable `allowDirectConnect` in `config.json`.')
                ]
            });
        }

        const embed = new EmbedBuilder()
            .setColor(0x2C3E50)
            .setTitle('Connecting bots')
            .setDescription(`Starting **${countToUse}** bot(s) across lobbies \`1\`-\`${countToUse}\`.`)
            .addFields(
                { name: 'Target server', value: `${this.config.hypixel?.host || 'mc.hypixel.net'}:${this.config.hypixel?.port || 25565}`, inline: true },
                { name: 'Lobby allocation', value: `1 bot per lobby (1-${countToUse})`, inline: true },
                { name: 'Proxy mode', value: proxies.length > 0 ? `SOCKS5/HTTP (${proxies.length} loaded)` : 'Direct connection', inline: true }
            )
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });

        // Start bots in background
        startBots(selectedAccounts, this).catch(err => {
            console.error('[Discord] Error starting bots:', err);
        });
    }

    async handleDisconnectCommand(interaction) {
        await interaction.deferReply();

        const stoppedCount = await stopBots();

        const embed = new EmbedBuilder()
            .setColor(0x36393F)
            .setTitle('Bots disconnected')
            .setDescription(`Disconnected **${stoppedCount}** active bot(s).`)
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
    }

    async handleStatusCommand(interaction) {
        await interaction.deferReply();

        const active = getActiveBots();
        const proxies = ProxyManager.loadProxies();
        const totalCookie = AccountManager.loadAccountsByType('cookie').length;
        const totalMicrosoft = AccountManager.loadAccountsByType('microsoft').length;
        const trackedCount = TrackerDB.getAll().length;
        const summary = LobbyCoordinator.getSummary();

        const embed = new EmbedBuilder()
            .setColor(active.length > 0 ? 0x2F4F3E : 0x36393F)
            .setTitle('Bedwars lobby watcher status')
            .addFields(
                { name: 'Active bots', value: `${active.length}`, inline: true },
                { name: 'Lobby coverage', value: `${summary.occupiedCount}/${summary.totalLobbies}`, inline: true },
                { name: 'Working proxies', value: `${proxies.length}`, inline: true },
                { name: 'Stored accounts', value: `${totalCookie} cookie / ${totalMicrosoft} MS`, inline: true },
                { name: 'Tracked targets', value: `${trackedCount} player(s)`, inline: true }
            )
            .setTimestamp();

        if (active.length > 0) {
            const sortedBots = [...active].sort((a, b) => (a.assignedLobby || 99) - (b.assignedLobby || 99));
            const botList = sortedBots.map(b => {
                const uptime = Math.floor((Date.now() - b.connectedAt) / 1000);
                const assignedText = b.assignedLobby ? `Lobby #${b.assignedLobby}` : 'Unassigned';
                const statusText = b.lobby && b.assignedLobby && b.lobby.toLowerCase().includes(`bedwarslobby${b.assignedLobby}`)
                    ? 'on target'
                    : 'routing';
                return `**${b.name}** (${statusText}) — target: \`${assignedText}\`, current: \`${b.lobby}\` (${uptime}s)`;
            }).join('\n');

            embed.addFields({
                name: 'Lobby assignments',
                value: botList.length > 1024 ? botList.slice(0, 1000) + '...' : botList,
                inline: false
            });
        }

        await interaction.editReply({ embeds: [embed] });
    }

    async handleTrackCommand(interaction) {
        await interaction.deferReply();
        const sub = interaction.options.getSubcommand();

        if (sub === 'add') {
            const username = interaction.options.getString('username');
            const note = interaction.options.getString('note') || '';
            const userTag = interaction.user.tag || interaction.user.username;

            const res = TrackerDB.addPlayer(username, userTag, note);
            const player = res.player;

            const embed = new EmbedBuilder()
                .setColor(0x2F4F3E)
                .setTitle(res.isNew ? 'Player added' : 'Player updated')
                .setDescription(`Tracking **${player.username}** in Hypixel Bedwars lobbies.`)
                .addFields(
                    { name: 'Username', value: `\`${player.username}\``, inline: true },
                    { name: 'Note', value: player.note || '*None*', inline: true },
                    { name: 'Added by', value: `<@${interaction.user.id}>`, inline: true }
                )
                .setThumbnail(`https://mc-heads.net/avatar/${player.username}/100`)
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });
        } else if (sub === 'remove') {
            const username = interaction.options.getString('username');
            const removed = TrackerDB.removePlayer(username);

            if (removed) {
                const embed = new EmbedBuilder()
                    .setColor(0x36393F)
                    .setTitle('Player removed')
                    .setDescription(`**${removed.username}** is no longer being tracked.`)
                    .setTimestamp();

                await interaction.editReply({ embeds: [embed] });
            } else {
                const embed = new EmbedBuilder()
                    .setColor(0x6B4A1E)
                    .setTitle('Player not found')
                    .setDescription(`**${username}** was not found in the tracking database.`)
                    .setTimestamp();

                await interaction.editReply({ embeds: [embed] });
            }
        } else if (sub === 'list') {
            const players = TrackerDB.getAll();

            if (players.length === 0) {
                const embed = new EmbedBuilder()
                    .setColor(0x36393F)
                    .setTitle('Tracked players')
                    .setDescription('No players are currently being tracked.\nUse `/track add <username>` to start tracking someone.')
                    .setTimestamp();

                return interaction.editReply({ embeds: [embed] });
            }

            const embed = new EmbedBuilder()
                .setColor(0x2C3E50)
                .setTitle(`Tracked players (${players.length})`)
                .setTimestamp();

            const lines = players.map((p, i) => {
                const lastSeenText = p.lastSeen 
                    ? `• Last in \`${p.lastLobby || 'Lobby'}\` (<t:${Math.floor(p.lastSeen / 1000)}:R>)` 
                    : '• *Never seen yet*';
                const noteText = p.note ? ` - *${p.note}*` : '';
                return `**${i + 1}. ${p.username}**${noteText}\n${lastSeenText}`;
            });

            embed.setDescription(lines.join('\n\n').slice(0, 4000));
            await interaction.editReply({ embeds: [embed] });
        } else if (sub === 'clear') {
            TrackerDB.clear();

            const embed = new EmbedBuilder()
                .setColor(0x36393F)
                .setTitle('Tracking cleared')
                .setDescription('All players have been removed from the tracking list.')
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });
        }
    }

    async handleTmCommand(interaction) {
        await interaction.deferReply();
        const role = interaction.options.getRole('role');

        if (!role) {
            NotifySettings.setMentionRole(null);
            return interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setColor(0x36393F)
                        .setTitle('Join mentions disabled')
                        .setDescription('No role will be mentioned when a tracked player joins a lobby.')
                ]
            });
        }

        NotifySettings.setMentionRole(role.id);
        await interaction.editReply({
            embeds: [
                new EmbedBuilder()
                    .setColor(0x2F4F3E)
                    .setTitle('Join mentions enabled')
                    .setDescription(`${role} will be mentioned when a tracked player joins a lobby.`)
            ]
        });
    }

    // --- Message & Notification Senders ---

    // Sends up to a handful of relayed lobby chat lines as one plain, monospaced
    // message instead of an embed per line (lines is an array of "user: message" strings).
    async sendLobbyChatBatch(lines) {
        if (!lines || lines.length === 0) return;

        if (!this.chatChannel && this.config.discord?.chatChannelId) {
            try {
                this.chatChannel = await this.client.channels.fetch(this.config.discord.chatChannelId);
            } catch (e) {}
        }
        if (!this.chatChannel) return;

        try {
            const body = lines.join('\n');
            await this.chatChannel.send({ content: `\`\`\`\n${body}\n\`\`\`` });
        } catch (err) {
            console.error(`[Discord] Failed to send lobby chat batch: ${err.message}`);
        }
    }

    // Tracked-player chat goes to the status channel, not the general chat channel.
    async sendTrackedChatEmbed(embed) {
        if (!this.statusChannel && this.config.discord?.statusChannelId) {
            try {
                this.statusChannel = await this.client.channels.fetch(this.config.discord.statusChannelId);
            } catch (e) {}
        }
        if (!this.statusChannel) return;

        try {
            await this.statusChannel.send({ embeds: [embed] });
        } catch (err) {
            console.error(`[Discord] Failed to send tracked chat embed: ${err.message}`);
        }
    }

    async sendEventEmbed(embed) {
        if (!this.eventsChannel && this.config.discord?.eventsChannelId) {
            try {
                this.eventsChannel = await this.client.channels.fetch(this.config.discord.eventsChannelId);
            } catch (e) {}
        }
        if (!this.eventsChannel) return;

        await this.eventsChannel.send({ embeds: [embed] });
    }

    // Same as sendEventEmbed, but pings the /tm mention role (if one is set).
    // Used only for tracked-player joins, not leaves or presence checks.
    async sendTrackedJoinAlert(embed) {
        if (!this.eventsChannel && this.config.discord?.eventsChannelId) {
            try {
                this.eventsChannel = await this.client.channels.fetch(this.config.discord.eventsChannelId);
            } catch (e) {}
        }
        if (!this.eventsChannel) return;

        const roleId = NotifySettings.getMentionRoleId();
        const payload = { embeds: [embed] };
        if (roleId) {
            payload.content = `<@&${roleId}>`;
            payload.allowedMentions = { roles: [roleId] };
        }

        try {
            await this.eventsChannel.send(payload);
        } catch (err) {
            console.error(`[Discord] Failed to send tracked join alert: ${err.message}`);
        }
    }

    async sendStatusEmbed({ title, description, color = 0x2C3E50 }) {
        const target = this.statusChannel || this.eventsChannel;
        if (!target) return;

        const embed = new EmbedBuilder()
            .setColor(color)
            .setTitle(title)
            .setDescription(description)
            .setTimestamp();

        await target.send({ embeds: [embed] });
    }
}

module.exports = DiscordService;
