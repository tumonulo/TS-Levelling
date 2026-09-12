const { test } = require("node:test")
const assert = require("node:assert/strict")

const Tools = require("../classes/Tools.js")
const tools = new Tools()

const settings = {
    maxLevel: 1000,
    curve: { "1": 100, "2": 50, "3": 1 },
    rounding: 100,
    gain: { min: 50, max: 100, time: 60 }
}

// original linear implementation, kept as a reference oracle
function referenceGetLevel(xp, settings, returnRequirement) {
    let lvl = 0
    let previousLevel = 0
    let xpRequired = 0
    while (xp >= xpRequired && lvl <= settings.maxLevel) {
        lvl++
        previousLevel = xpRequired
        xpRequired = tools.xpForLevel(lvl, settings)
    }
    lvl--
    return returnRequirement ? { level: lvl, xpRequired, previousLevel } : lvl
}

test("xpForLevel computes rounded requirement", () => {
    assert.equal(tools.xpForLevel(5, settings), 1900)
    assert.equal(tools.xpForLevel(0, settings), 0)
})

test("xpForLevel caps at maxLevel", () => {
    assert.equal(tools.xpForLevel(2000, settings), tools.xpForLevel(1000, settings))
})

test("getLevel matches the reference implementation", () => {
    const samples = [0, 1, 50, 99, 100, 101, 1899, 1900, 1901, 50000, 1000000, 5e9]
    for (const xp of samples) {
        assert.equal(tools.getLevel(xp, settings), referenceGetLevel(xp, settings), `level mismatch for xp=${xp}`)
        assert.deepEqual(
            tools.getLevel(xp, settings, true),
            referenceGetLevel(xp, settings, true),
            `requirement mismatch for xp=${xp}`
        )
    }
})

test("getLevel returns level 0 for no xp", () => {
    assert.equal(tools.getLevel(0, settings), 0)
})

test("getLevel handles the max level cap", () => {
    const maxRequirement = tools.xpForLevel(settings.maxLevel, settings)
    assert.equal(tools.getLevel(maxRequirement + 999999, settings), settings.maxLevel)
})

test("getLevel requirement fields point at the next jump", () => {
    const result = tools.getLevel(1900, settings, true)
    assert.equal(result.level, 5)
    assert.equal(result.previousLevel, tools.xpForLevel(5, settings))
    assert.equal(result.xpRequired, tools.xpForLevel(6, settings))
})

test("getRolesForLevel keeps only the top role unless keep is set", () => {
    const rewards = [
        { id: "a", level: 5 },
        { id: "b", level: 10, keep: true },
        { id: "c", level: 15 }
    ]
    const expected = rewards.filter(r => r.id === "b")
    assert.deepEqual(tools.getRolesForLevel(12, rewards), expected)
    assert.deepEqual(tools.getRolesForLevel(20, rewards), [rewards[2], rewards[1]])
    assert.deepEqual(tools.getRolesForLevel(3, rewards), [])
})

test("commafy uses Spanish grouping separators", () => {
    assert.equal(tools.commafy(0), "0")
    assert.equal(tools.commafy(1234567), "1.234.567")
})

test("clamp limits a number between two values", () => {
    assert.equal(tools.clamp(5, 0, 10), 5)
    assert.equal(tools.clamp(-5, 0, 10), 0)
    assert.equal(tools.clamp(15, 0, 10), 10)
})

test("rng stays within the inclusive range", () => {
    for (let i = 0; i < 1000; i++) {
        const value = tools.rng(10, 20)
        assert.ok(value >= 10 && value <= 20)
    }
    assert.equal(tools.rng(5, 5), 5)
})

test("capitalize uppercases the first letter", () => {
    assert.equal(tools.capitalize("hello"), "Hello")
    assert.equal(tools.capitalize("hello world"), "Hello world")
    assert.equal(tools.capitalize("hello world", true), "Hello World")
})

test("limitLength truncates with an ellipsis", () => {
    assert.equal(tools.limitLength("short", 10), "short")
    assert.equal(tools.limitLength("this is long", 7), "this is...")
})

test("time formats durations", () => {
    assert.equal(tools.time(30_000), "30 seconds")
    assert.equal(tools.time(90_000), "2 minutes")
    assert.equal(tools.time(3_600_000), "1 hour")
    assert.equal(tools.time(3.6e19), "Forever")
})

test("xpObjToArray converts the stored object into an array with ids", () => {
    const users = { "1": { xp: 100 }, "2": { xp: 200 } }
    assert.deepEqual(tools.xpObjToArray(users), [
        { id: "1", xp: 100 },
        { id: "2", xp: 200 }
    ])
})

test("getLevel binary search matches the reference across many curves and xp values", () => {
    const curves = [
        { "1": 100, "2": 50, "3": 1 },
        { "1": 100, "2": 0, "3": 0 },
        { "1": 5, "2": 0, "3": 0 },
        { "1": 0, "2": 0, "3": 10 },
        { "1": 1000, "2": 3, "3": 0 }
    ]
    const maxLevels = [1, 2, 10, 100, 1000]
    const roundings = [1, 100, 1000]

    // deterministic pseudo-random xp values, capturing edge values too
    const xpSamples = [0, 1, 99, 100, 101, 999, 1000, 123456, 1e6, 1e9, 5e9, 0.5, 2 ** 31]
    let seed = 12345
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648)

    for (const curve of curves) {
        for (const maxLevel of maxLevels) {
            for (const rounding of roundings) {
                const settings = { maxLevel, curve, rounding }
                const values = [...xpSamples]
                for (let i = 0; i < 200; i++) values.push((rnd() % 5e7) + (rnd() % 1000))
                for (const xp of values) {
                    assert.equal(
                        tools.getLevel(xp, settings),
                        referenceGetLevel(xp, settings),
                        `level mismatch xp=${xp} maxLevel=${maxLevel} rounding=${rounding}`
                    )
                    assert.deepEqual(
                        tools.getLevel(xp, settings, true),
                        referenceGetLevel(xp, settings, true),
                        `requirement mismatch xp=${xp} maxLevel=${maxLevel} rounding=${rounding}`
                    )
                }
            }
        }
    }
})