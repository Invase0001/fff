const assert = require('assert');
const { extractChatSender } = require('../src/functions/lobbyWatcher');

function runChatTests() {
    console.log('--- Testing Hypixel Bedwars Chat Extractor ---');

    // 1. In-game player chat from real Bedwars lobby (from media_1789600377911.png)
    const validChatSamples = [
        {
            raw: "[372❄] [MVP++] kyriy: modern we're bestest of friends right!?",
            expectedUser: "kyriy",
            expectedText: "modern we're bestest of friends right!?"
        },
        {
            raw: "[2100⭐] [MVP++] ilyPurpled: .",
            expectedUser: "ilyPurpled",
            expectedText: "."
        },
        {
            raw: "[90⭐] [MVP++] Anger: i want you so bad",
            expectedUser: "Anger",
            expectedText: "i want you so bad"
        },
        {
            raw: "[223⭐] [VIP+] TheHendinBurgy: anyone gifting MVP OR MVP+!///////////",
            expectedUser: "TheHendinBurgy",
            expectedText: "anyone gifting MVP OR MVP+!///////////"
        },
        {
            raw: "[692⭐] [MVP++] Amazingoat1: 3/4 dont be like SoulConnection",
            expectedUser: "Amazingoat1",
            expectedText: "3/4 dont be like SoulConnection"
        },
        {
            raw: "[57⭐] [VIP+] firehawkfox: 1/2--",
            expectedUser: "firehawkfox",
            expectedText: "1/2--"
        },
        {
            raw: "[468⭐] [MVP++] TreDerp: LOL",
            expectedUser: "TreDerp",
            expectedText: "LOL"
        },
        {
            raw: "[692⭐] [MVP++] Amazingoat1: LMAO",
            expectedUser: "Amazingoat1",
            expectedText: "LMAO"
        },
        {
            raw: "[253⭐] [VIP+] jeettttttt: 3/4",
            expectedUser: "jeettttttt",
            expectedText: "3/4"
        },
        {
            raw: "[215⭐] [MVP+] SoulConnection: wow so funny",
            expectedUser: "SoulConnection",
            expectedText: "wow so funny"
        },
        {
            raw: "[215⭐] [MVP+] SoulConnection [TAG]: grow up",
            expectedUser: "SoulConnection",
            expectedText: "grow up"
        },
        {
            raw: "[937⭐] [MVP+] doorman58: 3/4 ! ! ! ! wooowowoowow",
            expectedUser: "doorman58",
            expectedText: "3/4 ! ! ! ! wooowowoowow"
        },
        {
            raw: "[4⭐] StrongestFemBoy: i just wanna to play bw man",
            expectedUser: "StrongestFemBoy",
            expectedText: "i just wanna to play bw man"
        },
        {
            raw: "[31⭐] [VIP+] draykonn: 3/4 2fkdr",
            expectedUser: "draykonn",
            expectedText: "3/4 2fkdr"
        },
        {
            raw: "BatuhanDinckol: hello without rank or star",
            expectedUser: "BatuhanDinckol",
            expectedText: "hello without rank or star"
        },
        {
            raw: "[MVP+] Notch: hello world",
            expectedUser: "Notch",
            expectedText: "hello world"
        },
        {
            raw: "[SHOUT] [372❄] [MVP++] kyriy: shout test",
            expectedUser: "kyriy",
            expectedText: "shout test"
        },
        {
            raw: "§b[MVP§c+§b] §aUser_123§f: §rHello §6world!",
            expectedUser: "User_123",
            expectedText: "Hello world!"
        }
    ];

    console.log('1. Testing extraction of valid Hypixel Bedwars chat messages...');
    for (const sample of validChatSamples) {
        const parsed = extractChatSender(sample.raw);
        assert(parsed !== null, `Failed to parse chat message: "${sample.raw}"`);
        assert.strictEqual(parsed.username, sample.expectedUser, `Expected username ${sample.expectedUser}, got ${parsed.username}`);
        assert.strictEqual(parsed.text, sample.expectedText, `Expected text "${sample.expectedText}", got "${parsed.text}"`);
    }
    console.log(`   ✅ Successfully parsed all ${validChatSamples.length} valid chat samples.`);

    // 2. System messages, join announcements, and guild spam that MUST be ignored (from media_1789600366257.png)
    const ignoredSamples = [
        "Guild > Envoy_of_Violet joined.",
        "Guild > GhxstGrim joined.",
        "Guild > Fer0boy joined.",
        "公会 > BHRN 加入了服务器",
        "Guild > BHRN joined.",
        "Guild > Envoy_of_Violet: hello guild",
        "Party > player123: let's go",
        "From [MVP+] Friend: whisper message",
        "To [MVP+] Friend: whisper reply",
        "[MVP+] GhostTech joined the lobby!",
        ">>> [MVP++] ColdUs joined the lobby! <<<",
        ">>> [MVP++] mahbod856 joined the lobby! <<<",
        "You were spawned in Limbo",
        "A kick occurred in your connection",
        "You are AFK. Move around to return to the game",
        "Reward Summary: +500 Bedwars EXP",
        "{\"server\":\"bedwarslobby3\",\"gametype\":\"BEDWARS\"}",
        "==================================================",
        "Profile: Bedwars",
        "Server: mini123A"
    ];

    console.log('2. Testing rejection of system, join, and guild messages...');
    for (const sample of ignoredSamples) {
        const parsed = extractChatSender(sample);
        assert.strictEqual(parsed, null, `Should have rejected system/guild message: "${sample}", but got: ${JSON.stringify(parsed)}`);
    }
    console.log(`   ✅ Successfully rejected all ${ignoredSamples.length} system and guild notices.`);

    console.log('✅ ALL CHAT EXTRACTION TESTS PASSED!');
}

runChatTests();
