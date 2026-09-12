const { test } = require("node:test")
const assert = require("node:assert/strict")

const LevelUpMessage = require("../classes/LevelUpMessage.js")
const NewMessage = require("../commands/events/message.js")
const Tools = require("../classes/Tools.js")

// freeze the clock so cooldown/xp writes are bit-identical between the two runs
Date.now = () => 1_700_000_000_000

// ---------------------------------------------------------------
// Fake in-memory MongoDB model (dotted paths, $set/$inc/$unset)
// ---------------------------------------------------------------
function deepClone(value) {
    return value === undefined ? value : JSON.parse(JSON.stringify(value))
}

function defaultSettings() {
    return {
        enabled: true,
        gain: { min: 50, max: 100, time: 60 },
        curve: { "1": 100, "2": 50, "3": 1 },
        rounding: 100,
        maxLevel: 10,
        levelUp: {
            enabled: false, embed: false, rewardRolesOnly: false,
            message: "", channel: "current", multiple: 1, multipleUntil: 20
        },
        multipliers: { roles: [], rolePriority: "largest", channels: [], channelStacking: "multiply" },
        rewards: [],
        rewardSyncing: { sync: "level", noManual: false, noWarning: false },
        leaderboard: { disabled: false, private: false, hideRoles: false, maxEntries: 0, minLevel: 0, ephemeral: false, embedColor: -1 },
        rankCard: { disabled: false, relativeLevel: false, hideCooldown: false, ephemeral: false, embedColor: -1 },
        hideMultipliers: false,
        manualPerms: false
    }
}

function getPath(obj, path) {
    return path.split(".").reduce((cur, seg) => (cur === undefined ? undefined : cur[seg]), obj)
}

function setPath(obj, path, value) {
    const segs = path.split(".")
    let cur = obj
    for (let i = 0; i < segs.length - 1; i++) {
        if (typeof cur[segs[i]] !== "object" || cur[segs[i]] === null) cur[segs[i]] = {}
        cur = cur[segs[i]]
    }
    cur[segs[segs.length - 1]] = value
}

function unsetPath(obj, path) {
    const segs = path.split(".")
    let cur = obj
    for (let i = 0; i < segs.length - 1; i++) {
        if (cur[segs[i]] === undefined) return
        cur = cur[segs[i]]
    }
    delete cur[segs[segs.length - 1]]
}

function pickPaths(doc, filterKeys) {
    const result = { _id: doc._id }
    for (const key of filterKeys) {
        if (!key.includes(".")) {
            result[key] = doc[key]
            continue
        }
        const segs = key.split(".")
        if (doc[segs[0]] === undefined || typeof doc[segs[0]] !== "object") continue
        let src = doc[segs[0]]
        let target = result[segs[0]] = {}
        for (let i = 1; i < segs.length - 1; i++) {
            if (src[segs[i]] === undefined) break
            src = src[segs[i]]
            if (typeof src !== "object") break
            target = target[segs[i]] = {}
        }
        if (src !== undefined && src !== null && typeof src === "object" && src[segs[segs.length - 1]] !== undefined) {
            target[segs[segs.length - 1]] = src[segs[segs.length - 1]]
        } else if (typeof src !== "object" && segs.length === 2) {
            target[segs[1]] = src
        }
    }
    return result
}

function createFakeDb(overrides = {}) {
    const doc = {
        _id: "g1",
        users: {},
        settings: defaultSettings(),
        info: { lastUpdate: 0, monthlyMessagesPeriod: "", monthlyTop: {} }
    }
    if (overrides.settings) Object.assign(doc.settings, deepClone(overrides.settings))
    if (overrides.users) Object.assign(doc.users, deepClone(overrides.users))
    if (overrides.enabled !== undefined) doc.settings.enabled = overrides.enabled
    return {
        doc,
        fetch: (id, filter) => ({
            exec: async () => {
                if (!filter) return doc
                const keys = Array.isArray(filter) ? filter.filter(Boolean) : Object.keys(filter)
                return pickPaths(doc, keys)
            }
        }),
        update: (id, data) => ({
            exec: async () => {
                if (data.$set) for (const [p, v] of Object.entries(data.$set)) setPath(doc, p, v)
                if (data.$inc) {
                    for (const [p, v] of Object.entries(data.$inc)) {
                        const current = getPath(doc, p)
                        setPath(doc, p, (current === undefined ? 0 : current) + v)
                    }
                }
                if (data.$unset) for (const p of Object.keys(data.$unset)) unsetPath(doc, p)
                return doc
            }
        }),
        create: async (data) => { if (data._id) doc._id = data._id }
    }
}

// The index.js helpers reproduced with the same logic (per-guild 15s meta cache)
function makeServerMetaMethods(db) {
    const cache = new Map()
    const TTL = 15 * 1000
    return {
        fetchMessageData: async (guildId) => {
            const entry = cache.get(guildId)
            if (entry && Date.now() - entry.timestamp < TTL) {
                return { settings: entry.meta.settings, info: entry.meta.info, users: undefined, full: null }
            }
            let server = await db.fetch(guildId).exec()
            if (!server) {
                await db.create({ _id: guildId })
                server = await db.fetch(guildId).exec()
            }
            cache.set(guildId, { timestamp: Date.now(), meta: { settings: server?.settings, info: server?.info } })
            return { settings: server?.settings, info: server?.info, users: server?.users, full: server }
        },
        fetchUserData: async (guildId, userId) => db.fetch(guildId, { [`users.${userId}`]: 1 }).exec(),
        invalidateServerCache: (guildId) => cache.delete(guildId)
    }
}

// The ORIGINAL message handler, verbatim in behaviour from HEAD
async function runOld(client, message, tools) {
    const config = require("../config.json")
    if (config.lockBotToDevOnly && !tools.isDev(message.author)) return

    const author = message.author.id
    let db = await tools.fetchSettings(author, message.guild.id)
    if (!db || !db.settings?.enabled) return

    await client.monthlyMaintenance(message.guild, db)
    db = await tools.fetchSettings(author, message.guild.id)

    const settings = db.settings
    let userData = db.users[author] || { xp: 0, cooldown: 0 }

    await client.db.update(message.guild.id, {
        $inc: {
            [`users.${author}.messages`]: 1,
            [`users.${author}.monthlyMessages`]: 1
        }
    }).exec()

    const milestoneRoleId = config.roles?.milestones?.id
    if (milestoneRoleId) {
        const role = message.guild.roles.cache.get(milestoneRoleId)
        if (role && !message.member.roles.cache.has(milestoneRoleId)) {
            message.member.roles.add(role).catch(() => {})
        }
    }

    if (userData.cooldown > Date.now()) return

    const multiplierData = tools.getMultiplier(message.member, settings, message.channel)
    if (multiplierData.multiplier <= 0) return

    const oldXP = userData.xp
    const xpRange = [settings.gain.min, settings.gain.max].map(x => Math.round(x * multiplierData.multiplier))
    const xpGained = tools.rng(...xpRange)

    if (xpGained > 0) userData.xp += Math.round(xpGained)
    else return

    const awardedXP = Math.round(xpGained)
    userData.xp = oldXP + awardedXP

    if (settings.gain.time > 0) userData.cooldown = Date.now() + (settings.gain.time * 1000)
    if (userData.hidden) userData.hidden = false

    client.db.update(message.guild.id, {
        $set: {
            [`users.${author}.xp`]: userData.xp,
            [`users.${author}.cooldown`]: userData.cooldown,
            [`users.${author}.hidden`]: userData.hidden || false
        },
        $inc: { [`users.${author}.monthlyXP`]: awardedXP }
    }).exec()

    const oldLevel = tools.getLevel(oldXP, settings)
    const newLevel = tools.getLevel(userData.xp, settings)
    const levelUp = newLevel > oldLevel

    const syncMode = settings.rewardSyncing.sync
    if (syncMode == "xp" || (syncMode == "level" && levelUp)) {
        const roleCheck = tools.checkLevelRoles(message.guild.roles.cache, message.member.roles.cache, newLevel, settings.rewards, null, oldLevel)
        tools.syncLevelRoles(message.member, roleCheck).catch(() => {})
    }

    if (levelUp && settings.levelUp.enabled && settings.levelUp.message) {
        const useMultiple = (settings.levelUp.multiple > 1 && (settings.levelUp.multipleUntil == 0 || (newLevel < settings.levelUp.multipleUntil)))
        if (!useMultiple || (newLevel % settings.levelUp.multiple == 0)) {
            const lvlMessage = new LevelUpMessage(settings, message, { oldLevel, level: newLevel, userData })
            lvlMessage.send()
        }
    }
}

// reference linear getLevel (exact HEAD behaviour)
function linearGetLevel(xp, settings, returnRequirement) {
    let lvl = 0
    let previousLevel = 0
    let xpRequired = 0
    while (xp >= xpRequired && lvl <= settings.maxLevel) {
        lvl++
        previousLevel = xpRequired
        xpRequired = xpForLevelRef(lvl, settings)
    }
    lvl--
    return returnRequirement ? { level: lvl, xpRequired, previousLevel } : lvl
}
function xpForLevelRef(lvl, settings) {
    if (lvl > settings.maxLevel) lvl = settings.maxLevel
    const xpRequired = Object.entries(settings.curve).reduce((total, n) => total + (n[1] * (lvl ** n[0])), 0)
    return settings.rounding > 1 ? settings.rounding * Math.round(xpRequired / settings.rounding) : Math.round(xpRequired)
}

function makeTools({ db, getLevelImpl, banRoleId, multiplier } = {}) {
    const getLevel = getLevelImpl || Tools.global.getLevel
    return {
        isDev: () => false,
        fetchSettings: async (userId, serverId) => {
            let data = await db.fetch(serverId, ["settings", userId ? `users.${userId}` : null]).exec()
            data = await db.fetch(serverId).exec()
            if (!data) {
                await db.create({ _id: serverId })
                return makeTools({ db, getLevelImpl, banRoleId }).fetchSettings(userId, serverId)
            }
            if (!data.users) data.users = {}
            return data
        },
        getMultiplier: (member) => {
            if (banRoleId && member.roles.cache.has(banRoleId)) return { multiplier: 0, role: 0, channel: 0, roleList: [], channelList: [] }
            if (multiplier !== undefined) return { multiplier, role: multiplier, channel: 1, roleList: [{ id: "r_boost", boost: multiplier }], channelList: [] }
            return { multiplier: 1, role: 1, channel: 1, roleList: [], channelList: [] }
        },
        rng: () => 100,
        getLevel,
        xpForLevel: Tools.global.xpForLevel,
        checkLevelRoles: (allRoles, roles, lvl, rewards) => {
            const sorted = rewards.filter(r => r.level <= lvl).sort((a, b) => b.level - a.level)
            const top = sorted[0]
            const shouldHave = top ? sorted.filter(r => r.keep || r.level === top.level) : []
            const current = rewards.filter(r => roles.has(r.id))
            return {
                current,
                shouldHave,
                correct: current.filter(r => shouldHave.some(s => s.id === r.id)),
                incorrect: current.filter(r => !shouldHave.some(s => s.id === r.id)),
                missing: shouldHave.filter(r => !current.some(c => c.id === r.id))
            }
        },
        syncLevelRoles: async () => {}
    }
}

function makeMember({ roles = [] } = {}) {
    const roleMap = new Map()
    roles.forEach((r, i) => {
        const id = typeof r === "string" ? r : r.id
        roleMap.set(id, { id, position: r.position ?? i })
    })
    return {
        id: "u1",
        displayName: "User",
        avatarLink: undefined,
        displayAvatarURL: () => "https://x.example/avatar.png",
        roles: {
            cache: roleMap,
            has: id => roleMap.has(id),
            add: async () => {}
        }
    }
}

function makeMessage({ member, guildId = "g1" } = {}) {
    const guildRoles = [{ id: "r_reward", name: "Reward" }]
    return {
        id: "m1",
        author: { id: member.id, bot: false, username: "tester", discriminator: "0001", displayName: "User" },
        guild: {
            id: guildId,
            name: "Guild",
            iconLink: undefined,
            iconURL: () => "https://x.example/icon.png",
            roles: { cache: { get: id => guildRoles.find(r => r.id === id), find: fn => guildRoles.find(fn) } },
            memberCount: 5
        },
        member,
        channel: { id: "c1", name: "general", isThread: () => false, parent: null }
    }
}

function makeHarness(dbOverrides = {}) {
    const oldDb = createFakeDb(dbOverrides)
    const newDb = createFakeDb(dbOverrides)
    const oldTools = makeTools({ db: oldDb, getLevelImpl: linearGetLevel })
    const oldClient = { db: oldDb, monthlyMaintenance: async () => {} }
    const oldMember = makeMember()
    const oldMessage = makeMessage({ member: oldMember })

    const newClient = { db: newDb, monthlyMaintenance: async () => {}, globalTools: new Tools(null) }
    Object.assign(newClient, makeServerMetaMethods(newDb))
    const newTools = newClient.globalTools
    newTools.isDev = () => false
    newTools.rng = () => 100
    newTools.getMultiplier = oldTools.getMultiplier
    newTools.checkLevelRoles = oldTools.checkLevelRoles
    newTools.syncLevelRoles = async () => {}
    const newMember = makeMember()
    const newMessage = makeMessage({ member: newMember })

    return {
        runOld: () => runOld(oldClient, oldMessage, oldTools),
        runNew: () => NewMessage.run(newClient, newMessage, newTools),
        compare: () => assert.deepEqual(newDb.doc, oldDb.doc)
    }
}

// patch LevelUpMessage.send so constructing level-up messages is safe in tests
LevelUpMessage.prototype.send = function () {}
LevelUpMessage.prototype.constructor.prototype.send = function () {}

test("message flow: disabled server produces identical state", async () => {
    const h = makeHarness({ enabled: false })
    await h.runOld()
    await h.runNew()
    h.compare()
})

test("message flow: first message grants xp identically", async () => {
    const h = makeHarness()
    await h.runOld()
    await h.runNew()
    h.compare()
})

test("message flow: cooldown blocks the second message identically", async () => {
    const h = makeHarness()
    await h.runOld()
    await h.runNew()
    h.compare()
    // second message falls inside the cooldown in both
    await h.runOld()
    await h.runNew()
    h.compare()
})

test("message flow: 0x ban role blocks xp identically", async () => {
    const oldDb = createFakeDb({})
    const newDb = createFakeDb({})
    const oldTools = makeTools({ db: oldDb, getLevelImpl: linearGetLevel, banRoleId: "r_ban" })
    const oldClient = { db: oldDb, monthlyMaintenance: async () => {} }
    const oldMember = makeMember({ roles: ["r_ban"] })
    await runOld(oldClient, makeMessage({ member: oldMember }), oldTools)

    const newClient = { db: newDb, monthlyMaintenance: async () => {}, globalTools: new Tools(null) }
    Object.assign(newClient, makeServerMetaMethods(newDb))
    const nt = newClient.globalTools
    nt.isDev = () => false
    nt.rng = () => 100
    nt.getMultiplier = oldTools.getMultiplier
    nt.checkLevelRoles = oldTools.checkLevelRoles
    nt.syncLevelRoles = async () => {}
    const newMember = makeMember({ roles: ["r_ban"] })
    await NewMessage.run(newClient, makeMessage({ member: newMember }), nt)

    assert.deepEqual(newDb.doc, oldDb.doc)
    assert.equal(newDb.doc.users.u1.xp || 0, 0)
})

test("message flow: crossing a level matches identically", async () => {
    const db = {
        settings: {
            maxLevel: 10,
            gain: { min: 100, max: 100, time: 0 },
            curve: { "1": 100, "2": 0, "3": 0 },
            rounding: 1,
            rewardSyncing: { sync: "level", noManual: false, noWarning: false },
            levelUp: { enabled: true, embed: false, rewardRolesOnly: false, message: "xx", channel: "current", multiple: 1, multipleUntil: 20 },
            rewards: [{ id: "r_reward", level: 1 }]
        },
        users: { u1: { xp: 50, cooldown: 0 } }
    }
    const h = makeHarness(db)
    await h.runOld()
    await h.runNew()
    h.compare()
})

test("message flow: hidden user gets unhidden identically", async () => {
    const h = makeHarness({ users: { u1: { xp: 0, cooldown: 0, hidden: true } } })
    await h.runOld()
    await h.runNew()
    h.compare()
})