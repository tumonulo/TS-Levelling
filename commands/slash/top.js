const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ContainerBuilder,
    MessageFlags,
    SeparatorBuilder,
    SeparatorSpacingSize,
    TextDisplayBuilder
} = require("discord.js")
const ranks = require("../../consts/ranks.js")

function getCurrentSpanishMonth() {
    return new Intl.DateTimeFormat("es-ES", {
        timeZone: "Europe/Madrid",
        month: "long"
    }).format(new Date())
}

// Ancho aproximado (en "unidades visuales") disponible antes de que Discord
// parta la línea en dos en una pantalla de móvil estrecha. Es una estimación
// -Discord no da un valor exacto y la fuente no es monoespaciada- pensada
// para quedar con margen de sobra en la mayoría de móviles.
const MOBILE_LINE_WIDTH = 57
const MONTHLY_LINE_WIDTH = 53
// Un emoji personalizado (<:nombre:id>) se ve como un solo icono pequeño,
// pero como texto pesa muchísimo más que eso: lo tratamos como si ocupara
// el ancho de 2 caracteres normales a la hora de medir.
const CUSTOM_EMOJI_VISUAL_WIDTH = 2

function estimateVisualWidth(text) {
    return text.replace(/<a?:\w+:\d+>/g, "*".repeat(CUSTOM_EMOJI_VISUAL_WIDTH)).length
}

// Recibe variantes del mismo texto de la más completa a la más corta y
// devuelve la primera que quepa en MOBILE_LINE_WIDTH. Si ni la más corta
// cabe, se devuelve igualmente esa (mejor esfuerzo).
function fitLine(...variants) {
    return variants.find(variant => estimateVisualWidth(variant) <= MOBILE_LINE_WIDTH)
        ?? variants[variants.length - 1]
}

function fitMonthlyLine(...variants) {
    return variants.find(variant => estimateVisualWidth(variant) <= MONTHLY_LINE_WIDTH)
        ?? variants[variants.length - 1]
}

module.exports = {
metadata: {
    name: "top",
    description: "View the server's XP leaderboard.",
    args: [
        { type: "user", name: "member", description: "Finds a certain member's position on the leaderboard", required: false },
        { type: "bool", name: "monthly", description: "Show this month's most active members", required: false }
    ]
},

async run(client, int, tools) {
    let lbLink = `${tools.WEBSITE}/leaderboard/${int.guild.id}`

    let db = await tools.fetchAll()
    if (!db) return tools.warn(`Nobody in this server is ranked yet!`)
    else if (!db.settings.enabled) return tools.warn("*xpDisabled")
    else if (db.settings.leaderboard.disabled) return tools.warn("The leaderboard is disabled in this server!" + (tools.canManageServer(int.member) ? `\nAs a moderator, you can still privately view the leaderboard here: ${lbLink}` : ""))

    if (client.monthlyMaintenance) {
        client.monthlyMaintenance(int.guild, db).catch(error => {
            console.warn(`Could not update monthly leaderboard for ${int.guild.id}:`, error.message)
        })
    }

    let pageSize = 8
    let monthlyMode = !!int.options.get("monthly")?.value

    let minLeaderboardXP = db.settings.leaderboard.minLevel > 1 ? tools.xpForLevel(db.settings.leaderboard.minLevel, db.settings) : 0
    const hasLeaderboardLevel = userData => Number(userData?.xp) > 0 && tools.getLevel(Number(userData.xp), db.settings) > 0
    const buildRankings = isMonthly => tools.xpObjToArray(db.users || {})
        .filter(x => hasLeaderboardLevel(x) && !x.hidden && (isMonthly ? tools.getMonthlyXP(x) > 0 : Number(x.xp) > minLeaderboardXP))
        .sort((a, b) => isMonthly
            ? tools.getMonthlyXP(b) - tools.getMonthlyXP(a)
                || tools.getMonthlyMessages(b) - tools.getMonthlyMessages(a)
                || b.xp - a.xp
            : b.xp - a.xp)
    let rankings = buildRankings(monthlyMode)

    let totalPages = Math.max(1, Math.ceil(rankings.length / pageSize))
    let pageNumber = 1

    let highlight = null
    let userSearch = int.options.get("user") || int.options.get("member") // option is "user" if from context menu
    if (userSearch) {
        let foundRanking = rankings.findIndex(x => x.id == userSearch.user.id)
        if (isNaN(foundRanking) || foundRanking < 0) return tools.warn(int.user.id == userSearch.user.id ? "No estas en el top!" : "Este miembro no esta en el top!")
        else pageNumber = Math.floor(foundRanking / pageSize) + 1
        highlight = userSearch.user.id
    }

    let isHidden = db.settings.leaderboard.ephemeral

    const configuredColor = db.settings.leaderboard.embedColor
    const accentColor = configuredColor && configuredColor !== -1
        ? (typeof configuredColor === "string"
            ? parseInt(configuredColor.replace("#", ""), 16)
            : configuredColor)
        : tools.COLOR

    const resolvedMembers = new Map()

    // Fetches only the members not already cached/resolved, in a single
    // batched request per page instead of one force-fetch per member.
    const resolvePageMembers = async userIds => {
        const missing = userIds.filter(id => !resolvedMembers.has(id))
        if (!missing.length) return

        const fetched = await int.guild.members.fetch({ user: missing }).catch(() => new Map())
        missing.forEach(id => resolvedMembers.set(id, fetched.get(id) ?? null))
    }

    const buildContainer = async page => {
        const pageData = rankings.slice((page - 1) * pageSize, page * pageSize)
        const pageUserIds = pageData.map(entry => String(entry.id))

        await resolvePageMembers(pageUserIds)

        const entryComponents = []
        const pageRankCounts = new Map()
        const getRankInfo = entry => {
            const level = tools.getLevel(entry.xp, db.settings)
            const reward = tools.getRolesForLevel(level, db.settings.rewards)[0]
            const rank = reward && ranks.find(rankData => rankData.roles.some(role => role.id === reward.id))
            const rankRole = rank?.roles.find(role => role.id === reward?.id)
            if (rank) pageRankCounts.set(rank.rank, (pageRankCounts.get(rank.rank) || 0) + 1)
            return { level, rank, rankRole }
        }

        const pageRankInfo = pageData.map(getRankInfo)
        const dominantRankName = [...pageRankCounts.entries()]
            .sort((a, b) => b[1] - a[1])[0]?.[0]
        const dominantRank = ranks.find(rankData => rankData.rank === dominantRankName)
        const pageAccentColor = monthlyMode
            ? 0x8ecae6
            : dominantRank
            ? parseInt(dominantRank.color.replace("#", ""), 16)
            : accentColor

        pageData.forEach((entry, index) => {
            const position = (page - 1) * pageSize + index + 1
            const userId = String(entry.id)
            const isHighlighted = entry.id === highlight
            const isRequester = entry.id === int.user.id
            const { level, rankRole } = pageRankInfo[index]
            const totalMessages = tools.commafy(tools.getMessages(entry))
            const monthlyMessages = tools.commafy(tools.getMonthlyMessages(entry))
            const monthlyXP = tools.commafy(tools.getMonthlyXP(entry))
            const member = resolvedMembers.get(userId)
            const user = member?.user || client.users.cache.get(userId)
            const displayName = member?.displayName || user?.globalName || user?.username
            const memberDisplay = member
                ? `<@${userId}>`
                : `<@${userId}>  🚪`
            const searchedMemberName = displayName || "Miembro"
            const memberMarker = isHighlighted && !isRequester
                ? `  <:member:1467596629787021415>** ${searchedMemberName || "Miembro"}**`
                : isRequester
                    ? "  <:member:1467596629787021415> **Tú**"
                    : ""
            entryComponents.push(new TextDisplayBuilder().setContent([
                `${rankRole?.emoji || "<:top:1467967277251956887>"} **#${position} - Nivel ${level} - ${memberDisplay}**${memberMarker}`,
                monthlyMode
                    ? fitMonthlyLine(
                        `-# <:messages:1467163578699354235> **${monthlyMessages}** mensajes este mes  -  <:XP:1467192533812645939> **${monthlyXP}** XP este mes`,
                        `-# <:messages:1467163578699354235> **${monthlyMessages}** msjs este mes  -  <:XP:1467192533812645939> **${monthlyXP}** XP este mes`,
                        `-# <:messages:1467163578699354235> **${monthlyMessages}** msjs mes  -  <:XP:1467192533812645939> **${monthlyXP}** XP mes`,
                        `-# <:messages:1467163578699354235> **${monthlyMessages}** msg  -  <:XP:1467192533812645939> **${monthlyXP}** XP`,
                        `-# <:messages:1467163578699354235> **${monthlyMessages}**  -  <:XP:1467192533812645939> **${monthlyXP}**`
                    )
                    : fitLine(
                        `-# <:messages:1467163578699354235> **${totalMessages}** mensajes totales  -  <:messages:1467163578699354235> **${monthlyMessages}** este mes`,
                        `-# <:messages:1467163578699354235> **${totalMessages}** msjs totales  -  <:messages:1467163578699354235> **${monthlyMessages}** este mes`,
                        `-# <:messages:1467163578699354235> **${totalMessages}** msjs totales  -  <:messages:1467163578699354235> **${monthlyMessages}** mes`,
                        `-# <:messages:1467163578699354235> **${totalMessages}** msjs  -  <:messages:1467163578699354235> **${monthlyMessages}** mes`,
                        `-# <:messages:1467163578699354235> **${totalMessages}**  -  <:messages:1467163578699354235> **${monthlyMessages}**`
                    )
            ].join("\n")))

            if (index < pageData.length - 1) {
                entryComponents.push(new SeparatorBuilder()
                    .setDivider(true)
                    .setSpacing(SeparatorSpacingSize.Small))
            }
        })

        if (!pageData.length) {
            entryComponents.push(new TextDisplayBuilder().setContent("*Aún no hay miembros en este top.*"))
        }

        const previousPage = page <= 1 ? totalPages : page - 1
        const nextPage = page >= totalPages ? 1 : page + 1
        const firstMember = (page - 1) * pageSize + 1
        const lastMember = Math.min(page * pageSize, rankings.length)
        const memberRange = rankings.length ? `Miembros **${firstMember}-${lastMember}** de **${rankings.length}**` : "**0 miembros**"
        const canNavigate = rankings.length > pageSize
        const navigation = [
            new ButtonBuilder()
                .setCustomId("top-prev")
                .setLabel(`<< Página ${previousPage}`)
                .setStyle(page <= 1 ? ButtonStyle.Secondary : ButtonStyle.Success)
                .setDisabled(!canNavigate),
            new ButtonBuilder()
                .setCustomId("top-next")
                .setLabel(`Página ${nextPage} >>`)
                .setStyle(page >= totalPages ? ButtonStyle.Secondary : ButtonStyle.Success)
                .setDisabled(!canNavigate),
            new ButtonBuilder()
                .setCustomId("top-toggle")
                .setLabel(monthlyMode ? "Cambiar a top global" : "Cambiar a top mensual")
                .setStyle(ButtonStyle.Primary),
        ]

        const container = new ContainerBuilder()
            .setAccentColor(pageAccentColor || tools.COLOR)
            .addTextDisplayComponents(new TextDisplayBuilder().setContent([
                `# <:top:1467967277251956887> ${monthlyMode ? `Top de ${getCurrentSpanishMonth().charAt(0).toUpperCase() + getCurrentSpanishMonth().slice(1)}` : "Top"} de ${int.guild.name}`
            ].join("\n")))

        container.addSeparatorComponents(new SeparatorBuilder()
            .setDivider(true)
            .setSpacing(SeparatorSpacingSize.Small))

        entryComponents.forEach(component => {
            if (component instanceof SeparatorBuilder) container.addSeparatorComponents(component)
            else container.addTextDisplayComponents(component)
        })

        return {
            container: container
                .addSeparatorComponents(new SeparatorBuilder()
                    .setDivider(true)
                    .setSpacing(SeparatorSpacingSize.Small))
                .addTextDisplayComponents(new TextDisplayBuilder().setContent(
                    `-# Página **${page}** de **${totalPages}**  -  ${memberRange}`))
                .addActionRowComponents(new ActionRowBuilder().addComponents(navigation)),
            pageUserIds
        }
    }

    if (pageNumber < 1 || pageNumber > totalPages) return tools.warn("There are no members on this page!")

    await int.deferReply({
        flags: MessageFlags.IsComponentsV2 | (isHidden ? MessageFlags.Ephemeral : 0)
    })

    const sendPage = async page => {
        const { container, pageUserIds } = await buildContainer(page)

        // Se incluye SIEMPRE a los usuarios de la página como mención real,
        // para que se resuelvan bien en cualquier dispositivo, pero con
        // SuppressNotifications para que no llegue push/sonido.
        await int.editReply({
            components: [container],
            flags: MessageFlags.IsComponentsV2 | MessageFlags.SuppressNotifications,
            allowedMentions: { users: pageUserIds, parse: [] },
        })
    }

    await sendPage(pageNumber)
    const message = await int.fetchReply()

    let buttonPressed = false
    const collector = message.createMessageComponentCollector()
    collector.on("collect", async button => {
        if (button.user.id !== int.user.id) return tools.buttonReply(button)
        if (buttonPressed) return

        buttonPressed = true
        await button.deferUpdate()

        if (button.customId === "top-prev") pageNumber = pageNumber <= 1 ? totalPages : pageNumber - 1
        if (button.customId === "top-next") pageNumber = pageNumber >= totalPages ? 1 : pageNumber + 1
        if (button.customId === "top-toggle") {
            monthlyMode = !monthlyMode
            rankings = buildRankings(monthlyMode)
            pageNumber = 1
            totalPages = Math.max(1, Math.ceil(rankings.length / pageSize))
        }

        try {
            await sendPage(pageNumber)
        } finally {
            buttonPressed = false
        }
    })

}}