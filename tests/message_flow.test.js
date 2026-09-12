const { test } = require("node:test")
const assert = require("node:assert/strict")

const LevelUpMessage = require("../classes/LevelUpMessage.js")
const NewMessage = require("../commands/events/message.js")
const Tools = require("../classes/Tools.js")

// freeze the clock so cooldown/xp writes are deterministic
Date.now = () => 1_700_000_000_000
const NOW = Date.now()

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

function createFakeDb(overrides = {}) {
    const doc = {
        _id: "g1",
        users: {},
        settings: defaultSettings(),
        info: { lastUpdate: 0, monthlyMessagesPeriod: "", monthlyTop: {} }
    }
    if (overrides.settings) Object.assign(doc.settings, deepClone(overrides.settings))
    if (overrides.users) Object.assign(doc.users, deepClone(overrides.users))
    if (overrides.info) Object.assign(doc.info, deepClone(overrides.info))
    if (overrides.enabled !== undefined) doc.settings.enabled = overrides.enabled
    return {
        doc,
        fetch: (id) => ({
            exec: async () => deepClone(doc)
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

// ---------------------------------------------------------------
// Harness: the real handler, stubbed tools/client/message
// ---------------------------------------------------------------
let levelUpSends = 0
LevelUpMessage.prototype.send = function () { levelUpSends++ }

function makeTools(db, { banRoleId, multiplier } = {}) {
    return {
        isDev: () => false,
        // mirrors Tools.fetchSettings: settings + the author's user entry
        fetchSettings: async (userId, serverId) => {
            const server = await db.fetch(serverId).exec()
            if (!server) {
                await db.create({ _id: serverId })
                return makeTools(db, { banRoleId, multiplier }).fetchSettings(userId, serverId)
            }
            const data = { _id: server._id, settings: server.settings, users: {} }
            if (userId && server.users && server.users[userId] !== undefined) {
                data.users[userId] = server.users[userId]
            }
            return data
        },
        getMultiplier: (member) => {
            if (banRoleId && member.roles.cache.has(banRoleId)) return { multiplier: 0, role: 0, channel: 0, roleList: [], channelList: [] }
            if (multiplier !== undefined) return { multiplier, role: multiplier, channel: 1, roleList: [{ id: "r_boost", boost: multiplier }], channelList: [] }
            return { multiplier: 1, role: 1, channel: 1, roleList: [], channelList: [] }
        },
        rng: () => 100,
        // keep `this` bound to the real Tools instance (getLevel uses this.xpForLevel)
        getLevel: (...args) => Tools.global.getLevel(...args),
        checkLevelRoles: () => ({}),
        syncLevelRoles: async function () { this.calls.push("sync"); },
        calls: []
    }
}

function makeMember({ id = "u1", roles = [] } = {}) {
    const roleMap = new Map()
    roles.forEach((r, i) => {
        const rid = typeof r === "string" ? r : r.id
        roleMap.set(rid, { id: rid, position: i })
    })
    return {
        id,
        displayName: "User",
        displayAvatarURL: () => "https://x.example/avatar.png",
        roles: {
            cache: roleMap,
            has: rid => roleMap.has(rid),
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
            iconURL: () => "https://x.example/icon.png",
            roles: { cache: { get: rid => guildRoles.find(r => r.id === rid), find: fn => guildRoles.find(fn) } },
            memberCount: 5
        },
        member,
        channel: { id: "c1", name: "general", isThread: () => false, parent: null }
    }
}

// the handler fires one db.update without awaiting it: flush pending promises
async function flush() {
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
}

function makeHarness(dbOverrides = {}, toolOpts = {}) {
    const db = createFakeDb(dbOverrides)
    const tools = makeTools(db, toolOpts)
    const maintenanceCalls = []
    const client = {
        db,
        monthlyMaintenance: async (guild, knownServer) => { maintenanceCalls.push({ guild, knownServer }) }
    }
    const member = makeMember({ roles: toolOpts.memberRoles || [] })
    const message = makeMessage({ member })
    return {
        db,
        tools,
        maintenanceCalls,
        run: async () => {
            levelUpSends = 0
            tools.calls.length = 0
            await NewMessage.run(client, message, tools)
            await flush()
        }
    }
}

// ---------------------------------------------------------------
// Behaviour tests
// ---------------------------------------------------------------
test("message flow: disabled server writes nothing", async () => {
    const h = makeHarness({ enabled: false })
    const before = deepClone(h.db.doc)
    await h.run()
    assert.deepEqual(h.db.doc, before)
    assert.equal(h.maintenanceCalls.length, 0)
})

test("message flow: first message grants xp and bumps counters", async () => {
    const h = makeHarness()
    await h.run()
    const user = h.db.doc.users.u1
    assert.equal(user.messages, 1)
    assert.equal(user.monthlyMessages, 1)
    assert.equal(user.xp, 100) // rng() is stubbed to 100
    assert.equal(user.monthlyXP, 100)
    assert.equal(user.cooldown, NOW + 60 * 1000)
    assert.equal(user.hidden, false)
})

test("message flow: maintenance receives the full server document", async () => {
    const h = makeHarness({
        users: {
            u1: { xp: 10, cooldown: 0 },
            u2: { xp: 20, cooldown: 0 },
            u3: { xp: 30, cooldown: 0 }
        },
        info: { lastUpdate: 0, monthlyMessagesPeriod: "2026-09", monthlyTop: {} }
    })
    await h.run()
    assert.equal(h.maintenanceCalls.length, 1)
    const known = h.maintenanceCalls[0].knownServer
    // must be the whole document (all users + info), not a projection:
    // otherwise maintenance can't compare periods or snapshot the month
    assert.deepEqual(Object.keys(known.users).sort(), ["u1", "u2", "u3"])
    assert.equal(known.info.monthlyMessagesPeriod, "2026-09")
})

test("message flow: cooldown blocks xp on the second message", async () => {
    const h = makeHarness()
    await h.run()
    await h.run()
    const user = h.db.doc.users.u1
    assert.equal(user.messages, 2)
    assert.equal(user.monthlyMessages, 2)
    assert.equal(user.xp, 100) // no extra xp inside the cooldown
    assert.equal(user.monthlyXP, 100)
})

test("message flow: 0x ban role blocks xp but still counts the message", async () => {
    const h = makeHarness({}, { banRoleId: "r_ban", memberRoles: ["r_ban"] })
    await h.run()
    const user = h.db.doc.users.u1
    assert.equal(user.messages, 1)
    assert.equal(user.monthlyMessages, 1)
    assert.equal(user.xp || 0, 0)
    assert.equal(user.monthlyXP || 0, 0)
})

test("message flow: crossing a level sends the level-up message and syncs roles", async () => {
    const h = makeHarness({
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
    })
    await h.run()
    const user = h.db.doc.users.u1
    assert.equal(user.xp, 150)
    assert.equal(Tools.global.getLevel(50, h.db.doc.settings), 0)
    assert.equal(Tools.global.getLevel(150, h.db.doc.settings), 1)
    assert.equal(levelUpSends, 1)
    assert.ok(h.tools.calls.includes("sync"))
})

test("message flow: hidden user gets unhidden", async () => {
    const h = makeHarness({ users: { u1: { xp: 0, cooldown: 0, hidden: true } } })
    await h.run()
    assert.equal(h.db.doc.users.u1.hidden, false)
})
