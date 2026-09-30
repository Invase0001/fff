const { EmbedBuilder } = require('discord.js');
const TrackerDB = require('../utils/TrackerDB');
const LobbyCoordinator = require('../utils/LobbyCoordinator');

function extractChatSender(message) {
    if (!message || typeof message !== 'string') return null;

    // Strip Minecraft § color formatting codes
    const clean = message.replace(/§[0-9a-fk-or]/gi, '').trim();

    // Exclude non-lobby channels (Guild, Party, Private PMs, etc.)
    if (
        clean.startsWith("Guild >") ||
        clean.startsWith("公会 >") ||
        clean.startsWith("Party >") ||
        clean.startsWith("From ") ||
        clean.startsWith("To ") ||
        clean.startsWith("Friend >")
    ) {
        return null;
    }

    // Exclude system notices, lobby join announcements, guild join notices
    if (
        clean.includes("joined the lobby") ||
        clean.includes("joined.") ||
        clean.includes("left.") ||
        clean.includes("joined the guild") ||
        clean.includes("left the guild") ||
        clean.includes("加入了服务器") ||
        clean.includes("离开了服务器") ||
        clean.startsWith(">>>") ||
        clean.startsWith("<<<") ||
        clean.startsWith("{") ||
        clean.startsWith("---") ||
        clean.startsWith("===") ||
        clean.startsWith("Reward Summary") ||
        clean.startsWith("Profile:") ||
        clean.startsWith("Server:") ||
        clean.startsWith("Mode:")
    ) {
        return null;
    }

    // A chat message must contain a colon separator
    if (!clean.includes(':')) {
        return null;
    }

    // Hypixel Bedwars chat pattern:
    // [Optional Channel SHOUT/ALL] [Optional Star/Level] [Optional Rank] Username [Optional Guild Tag]: Message
    const pattern = /^(?:\[(?:SHOUT|ALL)\]\s*)?(?:\[[^\]]*\d+[^\]]*\]\s*)?(?:\[[A-Za-z+ ]+\]\s*)?([a-zA-Z0-9_]{3,16})(?:\s*\[[^\]]+\])?\s*:\s*(.*)$/;

    const match = clean.match(pattern);
    if (match) {
        return {
            username: match[1],
            text: match[2].trim(),
            raw: clean
        };
    }

    return null;
}

// Extracts the numeric lobby id from a lobby name like "bedwarslobby3",
// avoiding false matches such as "bedwarslobby1" inside "bedwarslobby10".
function getLobbyNumberFromName(name) {
    if (!name || typeof name !== 'string') return null;
    const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    const match = normalized.match(/bedwarslobby(\d+)/);
    return match ? parseInt(match[1], 10) : null;
}

// Bedwars lobby mode-select portal locations (x, z). If a tracked player's last
// known position before leaving is within 3 blocks on both x and z of one of
// these, they queued for that mode rather than just disconnecting elsewhere.
// The portals sit close enough together that their 3-block boxes overlap, so
// detectModeFromPosition() picks the *nearest* matching portal rather than the
// first one in this list — otherwise an earlier portal's box would shadow the
// next one and every reading comes out one mode short (solo instead of
// doubles, doubles instead of threes, etc).
const MODE_PORTALS = [
    { mode: 'Solo', x: -6, z: -14 },
    { mode: 'Doubles', x: -3, z: -11 },
    { mode: 'Threes', x: -1, z: -7 },
    { mode: 'Fours', x: 0, z: -3 }
];

// pos is { x, y, z, yaw } — yaw is the player's last known horizontal look
// direction (radians), which is how far apart the overlapping portal boxes
// actually get resolved: whichever portal the player was facing wins, since
// that's the one they were interacting with, not just standing near.
function detectModeFromPosition(pos) {
    if (!pos) return null;

    const candidates = MODE_PORTALS.filter(portal =>
        Math.abs(pos.x - portal.x) <= 3 && Math.abs(pos.z - portal.z) <= 3
    );

    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0].mode;

    // Multiple portals are in range at once — use facing direction to break the tie.
    if (typeof pos.yaw === 'number') {
        // Mineflayer yaw convention: yaw 0 faces +Z, increasing yaw turns toward +X.
        const lookX = -Math.sin(pos.yaw);
        const lookZ = Math.cos(pos.yaw);

        let best = null;
        let bestAngle = Infinity;
        for (const portal of candidates) {
            const dx = portal.x - pos.x;
            const dz = portal.z - pos.z;
            const dist = Math.hypot(dx, dz) || 1;
            const dot = Math.max(-1, Math.min(1, (lookX * dx + lookZ * dz) / dist));
            const angle = Math.acos(dot);
            if (angle < bestAngle) {
                bestAngle = angle;
                best = portal.mode;
            }
        }
        return best;
    }

    // No look data cached yet — fall back to nearest by distance.
    let nearest = candidates[0];
    let nearestScore = Math.max(Math.abs(pos.x - nearest.x), Math.abs(pos.z - nearest.z));
    for (const portal of candidates.slice(1)) {
        const score = Math.max(Math.abs(pos.x - portal.x), Math.abs(pos.z - portal.z));
        if (score < nearestScore) {
            nearestScore = score;
            nearest = portal;
        }
    }
    return nearest.mode;
}

function setupLobbyWatcher(bot, accountName, discordService, config = {}, assignedLobby = null) {
    let currentLobby = "Unknown Lobby";
    let currentGameType = "UNKNOWN";
    let antiAfkTimer = null;
    let locrawCheckTimer = null;
    let lastRouteAttempt = 0;
    let routeAttempts = 0;

    const antiAfkInterval = (config.botSettings?.antiAfkIntervalSec || 25) * 1000;
    const lobbyNumber = assignedLobby || LobbyCoordinator.getAssignedLobby(accountName);
    const chatRelayLobbyNumber = config.botSettings?.chatRelayLobbyNumber ?? 1;
    const chatBatchSize = config.botSettings?.chatBatchSize || 4;
    const lobbyChatBatch = [];
    const lastKnownPosition = new Map(); // lowercase username -> {x, y, z, yaw}

    // Tracked players' entities may already be gone by the time 'playerLeft' fires,
    // so their position and facing direction are polled and cached continuously
    // while they're visible.
    const positionTrackTimer = setInterval(() => {
        if (!bot || !bot.players) return;
        for (const [username, info] of Object.entries(bot.players)) {
            if (username === bot.username || username === accountName) continue;
            if (!TrackerDB.isTracked(username)) continue;
            const entity = info.entity;
            const pos = entity?.position;
            if (pos) {
                lastKnownPosition.set(username.toLowerCase(), {
                    x: pos.x,
                    y: pos.y,
                    z: pos.z,
                    yaw: typeof entity.yaw === 'number' ? entity.yaw : null
                });
            }
        }
    }, 1000);

    function flushLobbyChatBatch() {
        if (lobbyChatBatch.length === 0) return;
        const lines = lobbyChatBatch.splice(0, lobbyChatBatch.length);
        if (discordService && discordService.sendLobbyChatBatch) {
            discordService.sendLobbyChatBatch(lines).catch(err => {
                log(`Failed to forward lobby chat batch to Discord: ${err.message}`);
            });
        }
    }

    function queueLobbyChatLine(line) {
        // Strip backticks so a chat message can't break out of the code block it's sent in.
        lobbyChatBatch.push(line.replace(/`/g, "'"));
        if (lobbyChatBatch.length >= chatBatchSize) {
            flushLobbyChatBatch();
        }
    }

    function log(msg) {
        console.log(`[LobbyWatcher - ${accountName} (Lobby #${lobbyNumber || '?'})] ${msg}`);
    }

    function checkAndRouteToBedwars() {
        if (!bot || !bot.chat) return;
        try {
            bot.chat("/locraw");
        } catch (e) {
            log(`Error sending /locraw: ${e.message}`);
        }
    }

    function routeToAssignedLobby() {
        const now = Date.now();
        if (now - lastRouteAttempt < 6000) return; // Cooldown between routing commands
        lastRouteAttempt = now;

        if (currentGameType !== "BEDWARS") {
            log(`Not in Bedwars (current: ${currentGameType || 'Unknown'}). Routing via /lobby bedwars...`);
            try {
                if (bot && bot.chat) {
                    bot.chat("/lobby bedwars");
                }
            } catch (err) {
                log(`Failed to dispatch /lobby bedwars: ${err.message}`);
            }
        } else if (lobbyNumber) {
            log(`In Bedwars. Swapping to assigned lobby #${lobbyNumber} via /swaplobby ${lobbyNumber}...`);
            try {
                if (bot && bot.chat) {
                    bot.chat(`/swaplobby ${lobbyNumber}`);
                }
            } catch (err) {
                log(`Failed to dispatch /swaplobby ${lobbyNumber}: ${err.message}`);
            }
        }

        setTimeout(() => {
            checkAndRouteToBedwars();
        }, 4000);
    }

    function triggerAntiLimbo() {
        log(`Limbo detected! Sending /lobby bedwars in 3 seconds...`);
        setTimeout(() => {
            if (bot && bot.chat) {
                try {
                    bot.chat("/lobby bedwars");
                    log(`Dispatched /lobby bedwars to exit Limbo.`);
                    setTimeout(() => checkAndRouteToBedwars(), 4000);
                } catch (err) {
                    log(`Failed to send lobby command: ${err.message}`);
                }
            }
        }, 3000);
    }

    function performAntiAfk() {
        if (!bot || !bot.entity) return;

        try {
            const yawDelta = (Math.random() - 0.5) * 0.4;
            const pitchDelta = (Math.random() - 0.5) * 0.2;
            const targetYaw = bot.entity.yaw + yawDelta;
            const targetPitch = Math.max(-1.5, Math.min(1.5, bot.entity.pitch + pitchDelta));
            bot.look(targetYaw, targetPitch, true);

            if (Math.random() > 0.5) {
                bot.swingArm('right');
            } else {
                bot.setControlState('sneak', true);
                setTimeout(() => {
                    if (bot) bot.setControlState('sneak', false);
                }, 300);
            }
        } catch (err) {}
    }

    const reportedPresent = new Set();

    function checkPresentTrackedPlayers() {
        if (!bot || !bot.players) return;

        for (const pName of Object.keys(bot.players)) {
            if (pName !== bot.username && pName !== accountName && TrackerDB.isTracked(pName)) {
                if (reportedPresent.has(`${pName}:${currentLobby}`)) {
                    continue;
                }
                reportedPresent.add(`${pName}:${currentLobby}`);

                TrackerDB.updateLastSeen(pName, currentLobby);
                const playerInfo = TrackerDB.getPlayer(pName);
                const noteText = playerInfo?.note ? `\n**Note**: ${playerInfo.note}` : '';

                log(`🎯 Tracked player present: ${pName} in ${currentLobby}`);

                const embed = new EmbedBuilder()
                    .setColor(0x2C3E50)
                    .setTitle('Tracked player present')
                    .setDescription(`**${pName}** is in **${currentLobby}**.${noteText}`)
                    .addFields(
                        { name: 'Lobby', value: `\`${currentLobby}\``, inline: true },
                        { name: 'Assigned lobby', value: `\`#${lobbyNumber || 'N/A'}\``, inline: true },
                        { name: 'Observed by', value: `\`${accountName}\``, inline: true },
                        { name: 'Time', value: `<t:${Math.floor(Date.now() / 1000)}:R>`, inline: true }
                    )
                    .setThumbnail(`https://mc-heads.net/avatar/${pName}/100`)
                    .setTimestamp();

                if (discordService && discordService.sendEventEmbed) {
                    discordService.sendEventEmbed(embed).catch(() => {});
                }
            }
        }
    }

    // --- Event Listeners ---

    bot.once('spawn', () => {
        log(`Bot spawned. Initializing watcher (Assigned: Lobby #${lobbyNumber || 'Default'})...`);

        // 1. First send locraw to identify current location
        setTimeout(() => {
            checkAndRouteToBedwars();
        }, 2000);

        // 2. If not in Bedwars, initiate routing after 4.5 seconds
        setTimeout(() => {
            if (currentGameType !== "BEDWARS") {
                routeToAssignedLobby();
            }
        }, 4500);

        // 3. Check for any already-present tracked players after lobby loads
        setTimeout(() => {
            checkPresentTrackedPlayers();
        }, 9000);

        antiAfkTimer = setInterval(() => {
            performAntiAfk();
        }, antiAfkInterval + Math.floor(Math.random() * 5000));

        locrawCheckTimer = setInterval(() => {
            checkAndRouteToBedwars();
        }, 60000);
    });

    bot.on('playerJoined', (player) => {
        if (!player || !player.username) return;
        if (player.username === bot.username || player.username === accountName) return;

        // ONLY alert if the player is in the tracked database
        if (TrackerDB.isTracked(player.username)) {
            TrackerDB.updateLastSeen(player.username, currentLobby);
            const playerInfo = TrackerDB.getPlayer(player.username);
            const noteText = playerInfo?.note ? `\n**Note**: ${playerInfo.note}` : '';

            log(`🚨 Tracked player joined: ${player.username} in ${currentLobby}`);

            const embed = new EmbedBuilder()
                .setColor(0x2F4F3E)
                .setTitle('Tracked player joined')
                .setDescription(`**${player.username}** joined **${currentLobby}**.${noteText}`)
                .addFields(
                    { name: 'Lobby', value: `\`${currentLobby}\``, inline: true },
                    { name: 'Assigned lobby', value: `\`#${lobbyNumber || 'N/A'}\``, inline: true },
                    { name: 'Observed by', value: `\`${accountName}\``, inline: true },
                    { name: 'Time', value: `<t:${Math.floor(Date.now() / 1000)}:R>`, inline: true }
                )
                .setThumbnail(`https://mc-heads.net/avatar/${player.username}/100`)
                .setTimestamp();

            if (discordService && discordService.sendTrackedJoinAlert) {
                discordService.sendTrackedJoinAlert(embed).catch(err => {
                    log(`Error sending tracked join embed: ${err.message}`);
                });
            }
        }
    });

    bot.on('playerLeft', (player) => {
        if (!player || !player.username) return;
        if (player.username === bot.username || player.username === accountName) return;

        // ONLY alert if the player is in the tracked database
        if (TrackerDB.isTracked(player.username)) {
            TrackerDB.updateLastSeen(player.username, currentLobby);
            const playerInfo = TrackerDB.getPlayer(player.username);
            const noteText = playerInfo?.note ? `\n**Note**: ${playerInfo.note}` : '';

            const lastPos = lastKnownPosition.get(player.username.toLowerCase());
            const mode = detectModeFromPosition(lastPos);
            lastKnownPosition.delete(player.username.toLowerCase());

            log(`📤 Tracked player left: ${player.username} from ${currentLobby}${mode ? ` (queued ${mode})` : ''}`);

            const embed = new EmbedBuilder()
                .setColor(0x8B2E2E)
                .setTitle('Tracked player left')
                .setDescription(`**${player.username}** left **${currentLobby}**.${noteText}`)
                .addFields(
                    { name: 'Lobby', value: `\`${currentLobby}\``, inline: true },
                    { name: 'Assigned lobby', value: `\`#${lobbyNumber || 'N/A'}\``, inline: true },
                    { name: 'Observed by', value: `\`${accountName}\``, inline: true },
                    { name: 'Mode', value: mode || 'Unknown', inline: true },
                    { name: 'Time', value: `<t:${Math.floor(Date.now() / 1000)}:R>`, inline: true }
                )
                .setThumbnail(`https://mc-heads.net/avatar/${player.username}/100`)
                .setTimestamp();

            if (discordService && discordService.sendEventEmbed) {
                discordService.sendEventEmbed(embed).catch(err => {
                    log(`Error sending tracked left embed: ${err.message}`);
                });
            }
        }
    });

    bot.on('message', (jsonMsg) => {
        const msgStr = jsonMsg.toString().trim();
        if (!msgStr) return;

        // 1. Locraw JSON handling
        if (msgStr.startsWith('{') && msgStr.endsWith('}')) {
            try {
                const locraw = JSON.parse(msgStr);
                const serverName = locraw.server || "";
                const gameType = locraw.gametype || "";
                const lobby = locraw.lobbyname || serverName || (lobbyNumber ? `bedwarslobby${lobbyNumber}` : "Bedwars Lobby");
                currentLobby = lobby;
                currentGameType = gameType;
                LobbyCoordinator.updateVerifiedLobby(accountName, lobby);

                if (serverName.toLowerCase().includes('limbo')) {
                    triggerAntiLimbo();
                } else if (gameType !== "BEDWARS") {
                    log(`Not in Bedwars (current: ${gameType || serverName}). Routing to Bedwars...`);
                    setTimeout(() => {
                        routeToAssignedLobby();
                    }, 2000);
                } else if (lobbyNumber) {
                    const expectedLobby = `bedwarslobby${lobbyNumber}`.toLowerCase();
                    const actualLobby = currentLobby.toLowerCase().replace(/[^a-z0-9]/g, '');
                    if (!actualLobby.includes(expectedLobby)) {
                        if (routeAttempts < 5) {
                            routeAttempts++;
                            log(`In Bedwars (${currentLobby}) but not assigned lobby #${lobbyNumber}. Swapping (attempt ${routeAttempts}/5)...`);
                            setTimeout(() => {
                                routeToAssignedLobby();
                            }, 3000);
                        } else {
                            log(`Max swap attempts reached for lobby #${lobbyNumber}. Staying in ${currentLobby} temporarily.`);
                        }
                    } else {
                        if (routeAttempts > 0) {
                            log(`✅ Successfully reached assigned lobby: ${currentLobby}`);
                        }
                        routeAttempts = 0;
                    }
                }
                return;
            } catch (e) {}
        }

        // 2. Hypixel Server Feedback / Swaplobby confirmation
        if (
            msgStr.startsWith("Sending you to") ||
            msgStr.includes("Connected to") ||
            msgStr.includes("already connected to this server")
        ) {
            log(`[Hypixel] ${msgStr}`);
            setTimeout(() => checkAndRouteToBedwars(), 3000);
        }
        if (
            msgStr.includes("server is currently full") ||
            msgStr.includes("kicked while joining that server")
        ) {
            log(`⚠️ [Hypixel] Target lobby #${lobbyNumber} is currently full or unavailable: ${msgStr}`);
        }

        // 3. Anti-Limbo Chat Detection
        if (
            msgStr.includes("You were spawned in Limbo") ||
            msgStr.includes("A kick occurred in your connection") ||
            msgStr.includes("You are AFK. Move around to return to the game") ||
            msgStr.includes("You are AFK. Move around to return from AFK.") ||
            msgStr.includes("You are currently in Limbo")
        ) {
            triggerAntiLimbo();
            return;
        }

        // 4. Chat messages handling
        const parsedChat = extractChatSender(msgStr);
        if (parsedChat) {
            const botUsername = bot.username || accountName;
            if (parsedChat.username.toLowerCase() === botUsername.toLowerCase()) {
                return; // Ignore bot's own chat
            }

            // A. Tracked player chat (highest priority embed)
            if (TrackerDB.isTracked(parsedChat.username)) {
                TrackerDB.updateLastSeen(parsedChat.username, currentLobby);
                const playerInfo = TrackerDB.getPlayer(parsedChat.username);

                log(`💬 [Tracked Chat] ${parsedChat.username} in ${currentLobby}: ${parsedChat.text}`);

                const embed = new EmbedBuilder()
                    .setColor(0x4A235A)
                    .setAuthor({
                        name: `${parsedChat.username} - ${currentLobby}`,
                        iconURL: `https://mc-heads.net/avatar/${parsedChat.username}/100`
                    })
                    .setDescription(`**Message:** ${parsedChat.text}`)
                    .addFields(
                        { name: 'Lobby', value: `\`${currentLobby}\``, inline: true },
                        { name: 'Assigned lobby', value: `\`#${lobbyNumber || 'N/A'}\``, inline: true },
                        { name: 'Observed by', value: `\`${accountName}\``, inline: true }
                    )
                    .setFooter({ text: playerInfo?.note ? `Note: ${playerInfo.note}` : `Relayed by ${accountName}` })
                    .setTimestamp();

                if (discordService && discordService.sendTrackedChatEmbed) {
                    discordService.sendTrackedChatEmbed(embed).catch(err => {
                        log(`Failed to forward tracked chat to Discord: ${err.message}`);
                    });
                }
            }
            // B. General Lobby Chat (forwarded when logAllLobbyChat is enabled, lobby N only)
            else if (config.botSettings?.logAllLobbyChat !== false) {
                // Only forward when in a recognized Bedwars lobby (not Limbo or Unknown Lobby)
                // and only from the designated relay lobby, so chat from every lobby isn't dumped
                // into the same Discord channel at once.
                if (currentLobby !== "Unknown Lobby" && getLobbyNumberFromName(currentLobby) === chatRelayLobbyNumber) {
                    log(`💬 [Lobby Chat] ${parsedChat.username}: ${parsedChat.text}`);
                    // raw keeps the rank/star/guild-tag prefixes exactly as Hypixel sent them,
                    // instead of the stripped-down "username: text" form.
                    queueLobbyChatLine(parsedChat.raw);
                }
            }
        }
    });

    // Called by the global 5-minute lobby audit in mineflayer.js. Confirms this
    // bot is actually sitting in its assigned Bedwars lobby and re-routes it if not.
    function verifyAndCorrectLobby() {
        if (!lobbyNumber) return { ok: true, currentLobby, assignedLobby: null };

        const actualNumber = getLobbyNumberFromName(currentLobby);
        const inAssignedLobby = currentGameType === "BEDWARS" && actualNumber === lobbyNumber;

        if (!inAssignedLobby) {
            log(`5-minute lobby check: expected #${lobbyNumber}, currently in ${currentLobby}. Re-routing...`);
            checkAndRouteToBedwars();
            setTimeout(() => routeToAssignedLobby(), 2000);
        }

        return { ok: inAssignedLobby, currentLobby, assignedLobby: lobbyNumber };
    }

    const cleanup = () => {
        if (antiAfkTimer) clearInterval(antiAfkTimer);
        if (locrawCheckTimer) clearInterval(locrawCheckTimer);
        if (positionTrackTimer) clearInterval(positionTrackTimer);
        flushLobbyChatBatch();
        LobbyCoordinator.releaseLobby(accountName);
    };

    bot.on('end', cleanup);
    bot.on('kicked', cleanup);
    bot.on('error', cleanup);

    return {
        getCurrentLobby: () => currentLobby,
        getAssignedLobby: () => lobbyNumber,
        verifyAndCorrectLobby,
        cleanup
    };
}

module.exports = { setupLobbyWatcher, extractChatSender };
