const fastify = require("fastify")();
let activeBots = [];
let targetLocations = [];

async function startAPI(port = 4322) {
    try {
        const address = await fastify.listen({ port, host: "0.0.0.0" });
        console.log(`[BotAPI] Server is running at ${address}`);
    } catch (err) {
        console.warn(`[BotAPI] Notice: Could not bind API to port ${port}: ${err.message}`);
    }
}

async function stopAPI() {
    try {
        await fastify.close();
    } catch (err) {
        console.warn(`[BotAPI] Error while closing server: ${err.message}`);
    }
}

fastify.get("/bots", async (request, reply) => {
    reply.code(200).send({ success: true, bots: activeBots });
});

fastify.post("/target", async (request, reply) => {
    const chalk = (await import('chalk')).default;

    const { username, location, action } = request.body;
    if (!username || !location) {
        return reply.code(400).send({ success: false, message: "Username and location are required" });
    }

    const target = { username, location };

    if (action === "add") {
        if (!targetLocations.some(t => t.username === username && t.location === location)) {
            targetLocations.push(target);
            console.log(chalk.gray('[') + chalk.green('Autobot') + chalk.gray('] ') + chalk.yellow('Target added: ') + chalk.green(`${username}`) + chalk.yellow(` at `) + chalk.green(`${JSON.stringify(location)}`));
        }
    } else if (action === "remove") {
        targetLocations = targetLocations.filter(t => !(t.username === username));
        console.log(chalk.gray('[') + chalk.green('Autobot') + chalk.gray('] ') + chalk.yellow('Target removed: ') + chalk.red(`${username}`));
    }

    reply.code(200).send({ success: true, targetLocations });
});

function getLocation(uuid) {
    const bot = activeBots.find(bot => bot.uuid === uuid);
    if (bot) {
        return bot.location || null;
    }
    return null; 
}

async function addBot(bot) {
    const exists = activeBots.some(b => b.uuid === bot.uuid);
    if (!exists) {
        activeBots.push(bot);
    }
}

async function removeBot(uuid) {
    activeBots = activeBots.filter(bot => bot.uuid !== uuid);
}

async function updateBot(uuid, updatedData) {
    const botIndex = activeBots.findIndex(bot => bot.uuid === uuid);
    if (botIndex !== -1) {
        activeBots[botIndex] = { ...activeBots[botIndex], ...updatedData };
    }
}

function getTargetLocations() {
    return targetLocations;
}

module.exports = {
    startAPI,
    stopAPI,
    addBot,
    removeBot,
    updateBot,
    getTargetLocations,
    getLocation
};