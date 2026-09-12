const LevelUpMessage = require("../../classes/LevelUpMessage.js")
const config = require("../../config.json")

module.exports = {

async run(client, message, tools) {

    if (config.lockBotToDevOnly && !tools.isDev(message.author)) return

    // server settings are cached (15s TTL) and cheap to read, so this hot path
    // only does one small query per message instead of two full document fetches
    const author = message.author.id
    let data = await client.fetchMessageData(message.guild.id)
    if (!data.settings?.enabled) return

    await client.monthlyMaintenance(message.guild, data.full)

    let settings = data.settings

    // fetch the user's xp (already loaded on a cache miss, otherwise a single-user projection)
    let userData
    if (data.full) userData = data.full.users?.[author]
    else userData = (await client.fetchUserData(message.guild.id, author))?.users?.[author]
    if (!userData) userData = { xp: 0, cooldown: 0 }

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

    if (userData.cooldown > Date.now()) return // on cooldown, stop here

    // check role+channel multipliers, exit if 0x
    let multiplierData = tools.getMultiplier(message.member, settings, message.channel)
    if (multiplierData.multiplier <= 0) return

    // randomly choose an amount of XP to give
    let oldXP = userData.xp
    let xpRange = [settings.gain.min, settings.gain.max].map(x => Math.round(x * multiplierData.multiplier))
    let xpGained = tools.rng(...xpRange) // number between min and max, inclusive

    if (xpGained > 0) userData.xp += Math.round(xpGained)
    else return

    const awardedXP = Math.round(xpGained)
    userData.xp = oldXP + awardedXP
    
    // set xp cooldown
    if (settings.gain.time > 0) userData.cooldown = Date.now() + (settings.gain.time * 1000)
    
    // if hidden from leaderboard, unhide since they're no longer inactive
    if (userData.hidden) userData.hidden = false

    // database update
    client.db.update(message.guild.id, {
        $set: {
            [`users.${author}.xp`]: userData.xp,
            [`users.${author}.cooldown`]: userData.cooldown,
            [`users.${author}.hidden`]: userData.hidden || false
        },
        $inc: { [`users.${author}.monthlyXP`]: awardedXP }
    }).exec();

    // check for level up
    let oldLevel = tools.getLevel(oldXP, settings)
    let newLevel = tools.getLevel(userData.xp, settings)
    let levelUp = newLevel > oldLevel

    // auto sync roles on xp gain or level up
    let syncMode = settings.rewardSyncing.sync
    if (syncMode == "xp" || (syncMode == "level" && levelUp)) { 
        let roleCheck = tools.checkLevelRoles(message.guild.roles.cache, message.member.roles.cache, newLevel, settings.rewards, null, oldLevel)
        tools.syncLevelRoles(message.member, roleCheck).catch(() => {})
    }

    // level up message
    if (levelUp && settings.levelUp.enabled && settings.levelUp.message) {
        let useMultiple = (settings.levelUp.multiple > 1 && (settings.levelUp.multipleUntil == 0 || (newLevel < settings.levelUp.multipleUntil)))
        if (!useMultiple || (newLevel % settings.levelUp.multiple == 0)) {
            let lvlMessage = new LevelUpMessage(settings, message, { oldLevel, level: newLevel, userData })
            lvlMessage.send()
        }
    }

}}