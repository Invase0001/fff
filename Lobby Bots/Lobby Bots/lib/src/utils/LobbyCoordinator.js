/**
 * Hypixel Bedwars Lobby Coordinator & Alert Deduplicator
 * 
 * Coordinates exactly 1 bot per Bedwars lobby (lobbies 1 through 18)
 * and provides global sliding-window deduplication for player events and chat.
 */

class LobbyCoordinator {
    constructor(totalLobbies = 18, defaultAlertTtlMs = 15000) {
        this.totalLobbies = totalLobbies;
        this.defaultAlertTtlMs = defaultAlertTtlMs;
        // Map: lobbyNumber (1..totalLobbies) -> { lobbyNumber, botName, uuid, verifiedLobby, assignedAt }
        this.slots = new Map();
        // Deduplication cache: key -> timestamp
        this.alertCache = new Map();
    }

    /**
     * Acquire an available Bedwars lobby slot (1..18).
     * If the bot already has an assigned slot, returns that slot number.
     * @param {string} botName
     * @param {string} uuid
     * @returns {number|null} Assigned lobby number (1..18) or null if all slots are occupied.
     */
    acquireLobby(botName, uuid) {
        if (!botName && !uuid) return null;

        const nameLower = (botName || '').toLowerCase();
        const uuidLower = (uuid || '').toLowerCase();

        // If this bot is already assigned to a slot, keep it
        for (const [lobbyNum, slot] of this.slots.entries()) {
            if ((uuidLower && slot.uuid?.toLowerCase() === uuidLower) || 
                (nameLower && slot.botName?.toLowerCase() === nameLower)) {
                return lobbyNum;
            }
        }

        // Find the lowest unassigned lobby slot between 1 and totalLobbies
        for (let i = 1; i <= this.totalLobbies; i++) {
            if (!this.slots.has(i)) {
                this.slots.set(i, {
                    lobbyNumber: i,
                    botName: botName || `Bot-${i}`,
                    uuid: uuid || `uuid-${i}`,
                    verifiedLobby: 'Connecting...',
                    assignedAt: Date.now()
                });
                return i;
            }
        }

        return null; // All 18 lobbies are currently filled
    }

    /**
     * Release a lobby slot assigned to a bot.
     * @param {string} botNameOrUuid
     * @returns {number|null} The released lobby number, or null if not found.
     */
    releaseLobby(botNameOrUuid) {
        if (!botNameOrUuid) return null;
        const target = botNameOrUuid.toString().toLowerCase();

        for (const [lobbyNum, slot] of this.slots.entries()) {
            if (slot.uuid?.toLowerCase() === target || slot.botName?.toLowerCase() === target) {
                this.slots.delete(lobbyNum);
                return lobbyNum;
            }
        }
        return null;
    }

    /**
     * Retrieve the lobby number currently assigned to a bot.
     * @param {string} botNameOrUuid
     * @returns {number|null}
     */
    getAssignedLobby(botNameOrUuid) {
        if (!botNameOrUuid) return null;
        const target = botNameOrUuid.toString().toLowerCase();

        for (const [lobbyNum, slot] of this.slots.entries()) {
            if (slot.uuid?.toLowerCase() === target || slot.botName?.toLowerCase() === target) {
                return lobbyNum;
            }
        }
        return null;
    }

    /**
     * Update the verified lobby name confirmed by /locraw (e.g. "bedwarslobby3").
     * @param {string} botNameOrUuid
     * @param {string} actualLobbyName
     */
    updateVerifiedLobby(botNameOrUuid, actualLobbyName) {
        if (!botNameOrUuid || !actualLobbyName) return;
        const target = botNameOrUuid.toString().toLowerCase();

        for (const slot of this.slots.values()) {
            if (slot.uuid?.toLowerCase() === target || slot.botName?.toLowerCase() === target) {
                slot.verifiedLobby = actualLobbyName;
                break;
            }
        }
    }

    /**
     * Check whether an alert is a duplicate within the TTL window.
     * Returns true if it was already alerted recently (suppress).
     * Returns false if this is a fresh event (proceed and record timestamp).
     * 
     * @param {'join'|'leave'|'present'|'chat'} eventType
     * @param {string} player
     * @param {string} lobby
     * @param {string} extraData
     * @param {number} [customTtlMs]
     * @returns {boolean}
     */
    isDuplicateAlert(eventType, player, lobby = '', extraData = '', customTtlMs = null) {
        const now = Date.now();
        const ttl = customTtlMs || this.defaultAlertTtlMs;
        const pKey = (player || '').trim().toLowerCase();
        const lKey = (lobby || '').trim().toLowerCase();
        const eKey = (extraData || '').trim().toLowerCase();

        let cacheKey;
        if (eventType === 'chat') {
            // Deduplicate chat by sender + message body
            cacheKey = `chat:${pKey}:${eKey}`;
        } else if (eventType === 'present') {
            // Deduplicate initial presence by player + lobby
            cacheKey = `present:${pKey}:${lKey}`;
        } else {
            // Deduplicate join and leave per player
            cacheKey = `${eventType}:${pKey}`;
        }

        // Periodically purge entries older than 2 minutes
        if (this.alertCache.size > 300) {
            for (const [key, timestamp] of this.alertCache.entries()) {
                if (now - timestamp > 120000) {
                    this.alertCache.delete(key);
                }
            }
        }

        const lastTimestamp = this.alertCache.get(cacheKey);
        if (lastTimestamp && (now - lastTimestamp) < ttl) {
            return true; // Duplicate!
        }

        this.alertCache.set(cacheKey, now);
        return false; // Not a duplicate, allow alert
    }

    /**
     * Get a comprehensive summary of all 18 lobby slots.
     */
    getSummary() {
        const slotsList = [];
        for (let i = 1; i <= this.totalLobbies; i++) {
            const slot = this.slots.get(i);
            slotsList.push({
                lobbyNumber: i,
                occupied: !!slot,
                botName: slot ? slot.botName : null,
                uuid: slot ? slot.uuid : null,
                verifiedLobby: slot ? slot.verifiedLobby : null,
                assignedAt: slot ? slot.assignedAt : null
            });
        }

        return {
            totalLobbies: this.totalLobbies,
            occupiedCount: this.slots.size,
            freeCount: this.totalLobbies - this.slots.size,
            slots: slotsList
        };
    }

    /**
     * Reset all assigned slots and clear alert cache.
     */
    clear() {
        this.slots.clear();
        this.alertCache.clear();
    }
}

// Export singleton instance with default 18 lobbies
const instance = new LobbyCoordinator(18);
module.exports = instance;
module.exports.LobbyCoordinator = LobbyCoordinator;
