require('dotenv').config()
const Discord = require("discord.js")
const fs = require("fs")

const config = require("./config.json")
const mongoose = require("mongoose")

const Tools = require("./classes/Tools.js")
const Model = require("./classes/DatabaseModel.js")

// automatic files: these handle discorad status and version number, manage them with the dev commands
const autoPath = "./json/auto/"
if (!fs.existsSync(autoPath)) fs.mkdirSync(autoPath)
if (!fs.existsSync(autoPath + "status.json")) fs.copyFileSync("./json/default_status.json", autoPath + "status.json")
if (!fs.existsSync(autoPath + "version.json")) fs.writeFileSync(autoPath + "version.json", JSON.stringify({ version: "1.0.0", updated: Date.now() }, null, 2))

const rawStatus = require("./json/auto/status.json")
const version = require("./json/auto/version.json")

const startTime = Date.now()

const memberCleanupInterval = 6 * 60 * 60 * 1000
const memberCleanupBatchSize = 500
const monthlyLogChannelId = "1127922884568957010"
const importantLogThreadId = "1547719103169564783"
const staffRoleIds = new Set([
    "1106553480803516437",
    "1107345436492185753",
    "1106553536839422022",
    "1202685031219200040",
    "1107329826982989906",
    "1107331844866846770"
])
const memberFetchCacheTime = 6 * 60 * 60 * 1000
const memberFetchSpacing = 5000
const memberFetchBatchSize = 1000
const memberRetentionMinLevel = 15
const memberFetchState = new Map()
let memberFetchQueue = Promise.resolve()
let lastMemberFetch = 0

function getMemberScan(guildId) {
    return memberFetchState.get(guildId)?.members || null
}
function getMemberScanStatus(guildId) {
    const state = memberFetchState.get(guildId)
    return {
        complete: Boolean(state?.complete),
        scanning: Boolean(state?.promise)
    }
}

// create client
const client = new Discord.Client({
    allowedMentions: { parse: ["users"] },
    makeCache: Discord.Options.cacheWithLimits({ MessageManager: 0 }),
    intents: ['Guilds', 'GuildMembers', 'GuildMessages', 'DirectMessages', 'GuildVoiceStates'].map(i => Discord.GatewayIntentBits[i]),
    partials: ['Channel'].map(p => Discord.Partials[p]),
    failIfNotExists: false
})

if (!client.shard) {
    console.error("No sharding info found!\nMake sure you start the bot from polaris.js, not index.js")
    return process.exit()
}

client.shard.id = client.shard.ids[0]

client.getMemberScan = getMemberScan
client.getMemberScanStatus = getMemberScanStatus

client.globalTools = new Tools(client);

// connect to db
client.db = new Model("servers", require("./database_schema.js").schema)

// cached server settings for the message hot path (keeps the full users out of memory)
const serverMetaCache = new Map()
const serverMetaTTL = 15 * 1000

function getCachedServerMeta(guildId) {
    const entry = serverMetaCache.get(guildId)
    if (!entry) return null
    if (Date.now() - entry.timestamp >= serverMetaTTL) {
        serverMetaCache.delete(guildId)
        return null
    }
    return entry.meta
}

// fetches (or serves from cache) the settings/info used on the message hot path
async function fetchMessageData(guildId) {
    const cached = getCachedServerMeta(guildId)
    if (cached) return { settings: cached.settings, info: cached.info, users: undefined, full: null }

    let server = await client.db.fetch(guildId).exec()
    if (!server) {
        await client.db.create({ _id: guildId })
        server = await client.db.fetch(guildId).exec()
    }
    serverMetaCache.set(guildId, { timestamp: Date.now(), meta: { settings: server?.settings, info: server?.info } })
    return { settings: server?.settings, info: server?.info, users: server?.users, full: server }
}

// fetches a single user's data without pulling the whole server document
async function fetchUserData(guildId, userId) {
    return client.db.fetch(guildId, { [`users.${userId}`]: 1 }).exec()
}

client.fetchMessageData = fetchMessageData
client.fetchUserData = fetchUserData
client.getCachedServerMeta = getCachedServerMeta

// drop the cached settings so a settings change applies immediately
client.invalidateServerCache = guildId => serverMetaCache.delete(guildId)

// keep the cached period in sync right after a monthly rollover
function applyCachedPeriod(guildId, period) {
    const meta = getCachedServerMeta(guildId)
    if (meta) meta.info = { ...(meta.info || {}), monthlyMessagesPeriod: period }
}

function wait(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function hasRetainedProgress(userData, settings) {
    const xp = Number(userData?.xp)
    const minimumXp = client.globalTools.xpForLevel(memberRetentionMinLevel, settings)
    return xp >= minimumXp
}

function fetchMembersForMaintenance(guild) {
    const cached = memberFetchState.get(guild.id)
    if (cached?.members && Date.now() - cached.timestamp < memberFetchCacheTime) return Promise.resolve(cached.members)
    if (cached?.promise) return cached.promise

    const state = cached || {}
    state.members = new Map()
    state.complete = false
    const request = memberFetchQueue.then(async () => {
        const spacing = memberFetchSpacing - (Date.now() - lastMemberFetch)
        if (spacing > 0) await wait(spacing)
        const members = state.members
        let after = "0"
        let batchCount = 0

        while (true) {
            batchCount++
            const batch = await guild.members.list({ limit: memberFetchBatchSize, after })
            batch.forEach((member, id) => members.set(id, member))
            logImportant(
                `Escaneo de **${guild.name}**: registrados **${members.size}** miembros hasta ahora.`
            ).catch(() => {})
            client.emit("memberScanProgress", guild.id)
            if (batch.size < memberFetchBatchSize) break

            const nextAfter = batch.lastKey()
            if (!nextAfter || nextAfter === after) throw new Error("Member pagination did not advance")
            after = nextAfter
            await wait(500)
        }

        lastMemberFetch = Date.now()
        state.timestamp = lastMemberFetch
        state.complete = members.size >= guild.memberCount
        logImportant(
            `Escaneo de **${guild.name}** completado: **${members.size}/${guild.memberCount}** miembros.`
        ).catch(() => {})
        console.info(`Maintenance member scan for ${guild.name}: ${members.size}/${guild.memberCount} members in ${batchCount} batches`)
        return members
    }).catch(error => {
        console.warn(`Could not fetch members for maintenance in ${guild.id}:`, error.message)
        return null
    }).finally(() => {
        state.promise = null
    })

    state.promise = request
    memberFetchState.set(guild.id, state)
    memberFetchQueue = request.then(() => undefined, () => undefined)
    return request
}

function getMadridMonth() {
    const parts = new Intl.DateTimeFormat("en", {
        timeZone: "Europe/Madrid",
        year: "numeric",
        month: "2-digit"
    }).formatToParts(new Date())
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
    return `${values.year}-${values.month}`
}

function getMadridParts(date) {
    const parts = new Intl.DateTimeFormat("en", {
        timeZone: "Europe/Madrid",
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit"
    }).formatToParts(date)
    return Object.fromEntries(parts.map(part => [part.type, part.value]))
}

function getNextMadridMonthStart() {
    const current = getMadridParts(new Date())
    let year = Number(current.year)
    let month = Number(current.month) + 1
    if (month === 13) {
        month = 1
        year++
    }

    const utcEstimate = Date.UTC(year, month - 1, 1)
    for (let offset = -12; offset <= 14; offset++) {
        const candidate = new Date(utcEstimate - offset * 60 * 60 * 1000)
        const parts = getMadridParts(candidate)
        if (parts.year === String(year) && parts.month === String(month).padStart(2, "0") && parts.day === "01" && parts.hour === "00" && parts.minute === "00") return candidate
    }

    return new Date(utcEstimate)
}

function scheduleMadridMonthlyRollover() {
    const target = getNextMadridMonthStart()
    const delay = Math.max(target.getTime() - Date.now(), 1000)
    const checkDelay = Math.min(delay, 24 * 60 * 60 * 1000)
    setTimeout(async () => {
        if (Date.now() >= target.getTime()) await processMonthlyAllGuilds()
        scheduleMadridMonthlyRollover()
    }, checkDelay)
}

function getSpanishMonthName(period) {
    return new Intl.DateTimeFormat("es-ES", {
        timeZone: "Europe/Madrid",
        month: "long",
        year: "numeric"
    }).format(new Date(`${period}-02T12:00:00Z`))
}

function getMonthlySnapshot(server, members) {
    const users = Object.entries(server.users || {})
        .map(([id, data]) => ({ id, data, member: members.get(id) }))
        .filter(user => (user.data.monthlyXP || 0) > 0)

    users.sort((a, b) =>
        (b.data.monthlyXP || 0) - (a.data.monthlyXP || 0)
        || (b.data.monthlyMessages || 0) - (a.data.monthlyMessages || 0))
    const staff = users.filter(user => user.member?.roles.cache.some(role => staffRoleIds.has(role.id)))
    const membersTop = users.filter(user => !staff.includes(user))
    const serialize = entries => entries.slice(0, 10).map(user => ({
        id: user.id,
        level: client.globalTools.getLevel(user.data.xp || 0, server.settings),
        xp: user.data.monthlyXP || 0,
        messages: user.data.monthlyMessages || 0
    }))

    return { staff: serialize(staff), members: serialize(membersTop) }
}

async function logMonthlyTop(guild, snapshot, period) {
    const [channel, thread] = await Promise.all([
        client.channels.fetch(monthlyLogChannelId).catch(() => null),
        client.channels.fetch(importantLogThreadId).catch(() => null)
    ])
    const destinations = [channel, thread]
        .filter(destination => destination?.guild?.id === guild.id && destination.isTextBased())
        .filter((destination, index, all) => all.findIndex(item => item.id === destination.id) === index)
    if (destinations.length < 2) return false

    const formatTop = (title, entries) => {
        const lines = entries.map((user, index) =>
            `${index + 1}. <@${user.id}> - Nivel ${user.level} - **${client.globalTools.commafy(user.xp)} XP** - ${client.globalTools.commafy(user.messages)} mensajes`)
        return [`### ${title}`, lines.length ? lines.join("\n") : "-# Sin mensajes registrados"].join("\n")
    }
    const monthName = getSpanishMonthName(period)

    const message = {
        content: [
            `## Registro mensual - ${monthName}`,
            formatTop("Top 10 Staff", snapshot.staff),
            formatTop("Top 10 Miembros", snapshot.members)
        ].join("\n\n"),
        allowedMentions: { parse: [] }
    }
    const results = await Promise.allSettled(destinations.map(destination => destination.send(message)))
    return results.every(result => result.status === "fulfilled")
}

async function logImportant(message) {
    const thread = await client.channels.fetch(importantLogThreadId).catch(() => null)
    if (!thread?.isThread() || !thread.isTextBased()) return
    await thread.send({ content: `-# ${message}`, allowedMentions: { parse: [] } }).catch(() => {})
}

async function logCleanup(guild, message) {
    const [channel, thread] = await Promise.all([
        client.channels.fetch(importantLogThreadId).catch(() => null)
    ])
    const destinations = [channel, thread]
        .filter(destination => destination?.guild?.id === guild.id && destination.isTextBased())
        .filter((destination, index, all) => all.findIndex(item => item.id === destination.id) === index)
    await Promise.allSettled(destinations.map(destination => destination.send({
        content: `-# Limpieza de **${guild.name}**: ${message}`,
        allowedMentions: { parse: [] }
    })))
}

const monthlyMaintenanceLocks = new Set()
async function processMonthlyMessages(guild, knownServer, knownMembers) {
    if (monthlyMaintenanceLocks.has(guild.id)) return
    monthlyMaintenanceLocks.add(guild.id)

    try {
        const currentPeriod = getMadridMonth()
        // skip the DB entirely while the cached period is still current
        if (!knownServer) {
            const cached = getCachedServerMeta(guild.id)
            if (cached?.info?.monthlyMessagesPeriod === currentPeriod) return
        }

        const server = knownServer || await client.db.fetch(guild.id).exec()
        if (!server?.users) return

        const previousPeriod = server.info?.monthlyMessagesPeriod
        if (previousPeriod === currentPeriod) return

        const members = knownMembers || await fetchMembersForMaintenance(guild)
        if (!members) return
        if (!previousPeriod) {
            await client.db.update(guild.id, {
                $set: { "info.monthlyMessagesPeriod": currentPeriod }
            }).exec()
            applyCachedPeriod(guild.id, currentPeriod)
            return
        }

        const monthlyTop = getMonthlySnapshot(server, members)
        if (!await logMonthlyTop(guild, monthlyTop, previousPeriod)) return

        const resetUsers = Object.keys(server.users)
        for (let index = 0; index < resetUsers.length; index += memberCleanupBatchSize) {
            const batch = resetUsers.slice(index, index + memberCleanupBatchSize)
            const updates = Object.fromEntries(batch.flatMap(userId => [
                [`users.${userId}.monthlyMessages`, 0],
                [`users.${userId}.monthlyXP`, 0]
            ]))
            await client.db.update(guild.id, {
                $set: updates
            }).exec()
        }

        await client.db.update(guild.id, {
            $set: {
                "info.monthlyMessagesPeriod": currentPeriod,
                "info.monthlyTop": { period: previousPeriod, ...monthlyTop }
            }
        }).exec()
        applyCachedPeriod(guild.id, currentPeriod)
    } finally {
        monthlyMaintenanceLocks.delete(guild.id)
    }
}

client.monthlyMaintenance = processMonthlyMessages

async function processMonthlyAllGuilds() {
    for (const guild of client.guilds.cache.values()) {
        try {
            await processMonthlyMessages(guild)
        } catch (error) {
            console.warn(`Could not process monthly leaderboard for ${guild.id}:`, error.message)
        }
    }
}

async function cleanZeroXpMembers(guild) {
    const members = await fetchMembersForMaintenance(guild)
    if (!members || !members.size) {
        console.warn(`Skipping cleanup for ${guild.id}: Discord returned no members`)
        return
    }
    const memberScan = memberFetchState.get(guild.id)
    if (!memberScan?.complete) {
        console.warn(`Skipping cleanup for ${guild.id}: member scan was incomplete (${members.size}/${guild.memberCount})`)
        await logCleanup(guild, `omitida por seguridad: escaneo incompleto (**${members.size}/${guild.memberCount}** miembros).`)
        return
    }

    await processMonthlyMessages(guild, null, members)
    const server = await client.db.fetch(guild.id).exec()
    if (!server?.users) return

    const zeroXpUsers = Object.entries(server.users)
        .filter(([userId, userData]) => !members.has(userId) && !hasRetainedProgress(userData, server.settings))
        .map(([userId]) => userId)
    const preservedXpUsers = Object.entries(server.users)
        .filter(([userId, userData]) => !members.has(userId) && hasRetainedProgress(userData, server.settings))
        .length
    const retentionXp = client.globalTools.xpForLevel(memberRetentionMinLevel, server.settings)

    console.info(`Cleanup check for ${guild.name}: ${Object.keys(server.users).length} stored, ${members.size} current, ${zeroXpUsers.length} below ${retentionXp} XP, ${preservedXpUsers} absent users with XP preserved`)
    if (zeroXpUsers.length) {
        await logCleanup(guild, `encontrados **${zeroXpUsers.length}** registros ausentes con 0 XP; conservados **${preservedXpUsers}** ausentes con XP.`)
    } else if (preservedXpUsers) {
        await logCleanup(guild, `no hay registros ausentes con 0 XP; conservados **${preservedXpUsers}** usuarios ausentes con XP.`)
    }

    if (memberFetchState.get(guild.id) !== memberScan) {
        console.warn(`Skipping cleanup for ${guild.id}: membership changed during scan`)
        await logCleanup(guild, "omitida por seguridad: la pertenencia al servidor cambió durante el escaneo.")
        return
    }

    for (let index = 0; index < zeroXpUsers.length; index += memberCleanupBatchSize) {
        const batch = zeroXpUsers.slice(index, index + memberCleanupBatchSize)
        const unsetUsers = Object.fromEntries(batch.map(userId => [`users.${userId}`, 1]))
        await client.db.update(guild.id, { $unset: unsetUsers }).exec()
    }

    if (zeroXpUsers.length) {
        console.info(`Cleaned ${zeroXpUsers.length} zero-XP users from ${guild.name}`)
        const remainingServer = await client.db.fetch(guild.id).exec()
        const remaining = Object.entries(remainingServer?.users || {})
            .filter(([userId, userData]) => !members.has(userId) && !hasRetainedProgress(userData, remainingServer.settings)).length
        await logCleanup(guild, `eliminados **${zeroXpUsers.length}**; pendientes tras verificar: **${remaining}**.`)
    }
}

let memberCleanupRunning = false
async function cleanAllGuilds() {
    if (memberCleanupRunning) return
    memberCleanupRunning = true

    try {
        await logImportant(`Inicio de limpieza: comprobando **${client.guilds.cache.size}** servidores.`)
        for (const guild of client.guilds.cache.values()) {
            try {
                await cleanZeroXpMembers(guild)
            } catch (error) {
                console.warn(`Could not clean zero-XP users from ${guild.id}:`, error.message)
            }
        }
    } finally {
        memberCleanupRunning = false
    }
}

// command files
const dir = "./commands/"
client.commands = new Discord.Collection()
fs.readdirSync(dir).forEach(type => {
    fs.readdirSync(dir + type).filter(x => x.endsWith(".js")).forEach(file => {
        let command = require(dir + type + "/" + file)
        if (!command.metadata) command.metadata = { name: file.split(".js")[0] }
        command.metadata.type = type
        client.commands.set(command.metadata.name, command)
    })
})

client.statusData = rawStatus
client.updateStatus = function() {
    let status = client.statusData
    client.user.setPresence({ activities: status.type ? [{ name: status.name, state: status.state || undefined, type: Discord.ActivityType[status.type], url: status.url }] : [], status: status.status })
}

// when online
client.on("clientReady", () => {
    if (client.shard.id == client.shard.count - 1) console.log(`Bot online! (${+process.uptime().toFixed(2)} secs)`)
    client.startupTime = Date.now() - startTime
    client.version = version

    client.application.commands.fetch() // cache slash commands
    .then(cmds => {
        if (cmds.size < 1) { // no commands!! deploy to test server
            console.info("!!! No global commands found, deploying dev commands to test server (Use /deploy global=true to deploy global commands)")
            client.commands.get("deploy").run(client, null, client.globalTools)
        }
    })

    client.updateStatus()
    setInterval(client.updateStatus, 15 * 60000);

    for (const guild of client.guilds.cache.values()) {
        fetchMembersForMaintenance(guild).catch(error => {
            console.warn(`Could not warm member cache for ${guild.id}:`, error.message)
        })
    }

    const cleanupDelay = 30_000 + Math.floor(Math.random() * 90_000)
    setTimeout(() => {
        cleanAllGuilds()
        setInterval(cleanAllGuilds, memberCleanupInterval)
    }, cleanupDelay)
    scheduleMadridMonthlyRollover()

    // run the web server
    if (client.shard.id == 0 && config.enableWebServer) require("./web_app.js")(client)
})

// on message
client.on("messageCreate", async message => {
    if (message.system || message.author.bot) return
    else if (!message.guild || !message.member) return // dm stuff
    else client.commands.get("message").run(client, message, client.globalTools)
})

client.on("guildMemberRemove", async member => {
    memberFetchState.delete(member.guild.id)
    try {
        const server = await client.db.fetch(member.guild.id).exec()
        const userData = server?.users?.[member.id]
        if (!userData || hasRetainedProgress(userData, server.settings)) return

        await client.db.update(member.guild.id, {
            $unset: { [`users.${member.id}`]: 1 }
        }).exec()
        await logCleanup(member.guild, `eliminado **1** registro de **0 XP** tras salir el usuario.`)
    } catch (error) {
        console.warn(`Could not clean zero-XP data for ${member.id}:`, error)
    }
})

client.on("guildMemberAdd", member => {
    memberFetchState.delete(member.guild.id)
})

// on interaction
client.on("interactionCreate", async int => {
    
    if (!int.guild) return int.reply("You can't use commands in DMs!")
        
    // for setting changes
    if (int.isStringSelectMenu()) {
        if (int.customId.startsWith("configmenu_")) {
            if (int.customId.split("_")[1] != int.user.id) return int.deferUpdate()
            let configData = int.values[0].split("_").slice(1)
            let configCmd = (configData[0] == "dir" ? "button:settings_list" : "button:settings_view")
            client.commands.get(configCmd).run(client, int, new Tools(client, int), configData)
        }
        return;
    }

    // also for setting changes
    else if (int.isModalSubmit()) {
        if (int.customId.startsWith("configmodal")) {
            let modalData = int.customId.split("~")
            if (modalData[2] != int.user.id) return int.deferUpdate()
            client.commands.get("button:settings_edit").run(client, int, new Tools(client, int), modalData[1])
        }
        return;
    }

    // general commands and buttons
    let foundCommand = client.commands.get(int.isButton() ? `button:${int.customId.split("~")[0]}` : int.commandName)
    if (!foundCommand) return
    else if (foundCommand.metadata.slashEquivalent) foundCommand = client.commands.get(foundCommand.metadata.slashEquivalent)

    let tools = new Tools(client, int)

    // dev perm check
    if (foundCommand.metadata.dev && !tools.isDev()) return tools.warn("Only developers can use this!")
    else if (config.lockBotToDevOnly && !tools.isDev()) return tools.warn("Only developers can use this bot!")

    try {
        await foundCommand.run(client, int, tools)
    } catch (e) {
        console.error(e)

        const errorReply = {
            content: "**Error!** " + e.message,
            ephemeral: true
        }

        try {
            if (int.replied || int.deferred) await int.followUp(errorReply)
            else await int.reply(errorReply)
        } catch (replyError) {
            console.error("Could not send interaction error reply:", replyError)
        }
    }
})

client.on('error', e => console.warn(e))
client.on('warn', e => console.warn(e))

process.on('uncaughtException', e => console.warn(e))
process.on('unhandledRejection', (e, p) => console.warn(e))

// graceful shutdown: disconnect db and client before exiting
function shutdown(signal) {
    console.info(`Received ${signal}, shutting down gracefully...`)
    Promise.all([
        client.destroy().catch(() => {}),
        Promise.resolve().then(() => mongoose.disconnect()).catch(() => {})
    ]).finally(() => process.exit(0))
    setTimeout(() => process.exit(1), 10_000).unref()
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

client.login(process.env.DISCORD_TOKEN)