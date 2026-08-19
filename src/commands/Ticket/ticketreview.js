import { getColor } from '../../config/bot.js';
import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { getAllTicketsForGuild } from '../../utils/database.js';
import { botConfig } from '../../config/bot.js';

export default {
    data: new SlashCommandBuilder()
        .setName('ticketreview')
        .setDescription('View ticket reviews and staff performance')
        .setDMPermission(false)
        .addSubcommand((subcommand) =>
            subcommand
                .setName('all')
                .setDescription('View reviews and averages for all staff'),
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('staff')
                .setDescription('View reviews for a specific staff member')
                .addUserOption((option) =>
                    option
                        .setName('member')
                        .setDescription('The staff member to view stats for')
                        .setRequired(true),
                ),
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('me')
                .setDescription('View your own review statistics'),
        ),

    async execute(interaction, guildConfig, client) {
        const deferred = await InteractionHelper.safeDefer(interaction);
        if (!deferred) return;

        // Permission check (admins or configured roles)
        const allowedRoles = botConfig.reviewSystem?.allowedRoles || [];
        const hasPermission =
            interaction.memberPermissions.has(PermissionFlagsBits.Administrator) ||
            (allowedRoles.length > 0 && interaction.member.roles.cache.some(role => allowedRoles.includes(role.id)));

        if (!hasPermission) {
            return await replyUserError(interaction, {
                type: ErrorTypes.PERMISSION,
                message: "You don't have permission to use this command. Only admins or allowed roles can use this.",
            });
        }

        const subcommand = interaction.options.getSubcommand();
        const skipLabel = botConfig.reviewSystem?.skipLabel || 'Skipped';

        try {
            if (subcommand === 'all') {
                await handleViewAll(interaction, skipLabel);
            } else if (subcommand === 'staff') {
                const member = interaction.options.getUser('member');
                await handleViewStaff(interaction, member, skipLabel);
            } else if (subcommand === 'me') {
                await handleViewStaff(interaction, interaction.user, skipLabel);
            }
        } catch (error) {
            logger.error('Error executing ticketreview command:', {
                error: error.message,
                stack: error.stack,
                guildId: interaction.guildId,
                userId: interaction.user.id,
            });

            await replyUserError(interaction, {
                type: ErrorTypes.VALIDATION,
                message: 'An error occurred while retrieving ticket reviews.'
            });
        }
    }
};

async function handleViewAll(interaction, skipLabel) {
    const allTickets = await getAllTicketsForGuild(interaction.guildId);

    if (!allTickets || allTickets.length === 0) {
        return await InteractionHelper.safeEditReply(interaction, { content: 'No tickets found for this server.' });
    }

    // Consider any ticket that has rating or comment as a review
    const ticketsWithFeedback = allTickets.filter(t => t.rating !== null || t.comment);
    if (ticketsWithFeedback.length === 0) {
        return await InteractionHelper.safeEditReply(interaction, { content: 'No ticket reviews found yet.' });
    }

    // Overall averages
    const numericRatings = ticketsWithFeedback.map(t => (typeof t.rating === 'number' ? t.rating : null)).filter(r => r !== null);
    const overallAvg = numericRatings.length > 0 ? (numericRatings.reduce((s, r) => s + r, 0) / numericRatings.length) : 0;

    // Build staff statistics (based on claimedBy and closedBy)
    const staffIds = new Set();
    for (const t of allTickets) {
        if (t.claimedBy) staffIds.add(t.claimedBy);
        if (t.closedBy) staffIds.add(t.closedBy);
    }

    const staffStats = [];
    for (const id of Array.from(staffIds)) {
        const handled = allTickets.filter(t => t.claimedBy === id || t.closedBy === id);
        const handledWithFeedback = handled.filter(t => t.rating !== null || t.comment);
        const handledNumeric = handledWithFeedback.map(t => (typeof t.rating === 'number' ? t.rating : null)).filter(r => r !== null);
        const avg = handledNumeric.length > 0 ? (handledNumeric.reduce((s, r) => s + r, 0) / handledNumeric.length) : 0;

        staffStats.push({ id, total: handled.length, reviewed: handledWithFeedback.length, avg });
    }

    // Sort staff by reviewed count desc
    staffStats.sort((a, b) => b.reviewed - a.reviewed || b.avg - a.avg);

    const embeds = [];

    const summaryEmbed = new EmbedBuilder()
        .setTitle('📊 Ticket Review Overview - All Staff')
        .setColor(getColor('info'))
        .setTimestamp()
        .addFields(
            { name: 'Total Reviewed Tickets', value: String(ticketsWithFeedback.length), inline: true },
            { name: 'Average Rating (all)', value: overallAvg > 0 ? `${overallAvg.toFixed(2)}⭐` : 'N/A', inline: true },
            { name: 'Tickets with Ratings', value: String(numericRatings.length), inline: true },
        );

    embeds.push(summaryEmbed);

    // Add a page that lists staff summary rows (up to 10 per embed)
    const perPage = 10;
    for (let i = 0; i < staffStats.length; i += perPage) {
        const page = staffStats.slice(i, i + perPage);
        const embed = new EmbedBuilder()
            .setTitle(`👥 Staff Review Summary (${Math.floor(i / perPage) + 1})`)
            .setColor(getColor('primary'))
            .setTimestamp();

        for (const s of page) {
            const mention = `<@${s.id}>`;
            const avgDisplay = s.reviewed > 0 ? `${s.avg.toFixed(2)}⭐` : 'N/A';
            embed.addFields({ name: mention, value: `Handled: ${s.total}\nReviewed: ${s.reviewed}\nAvg: ${avgDisplay}`, inline: false });
        }

        embeds.push(embed);
    }

    // Also include detailed review pages (reuse ticket listing similar to ticketstats)
    const reviewsPerPage = 5;
    for (let i = 0; i < ticketsWithFeedback.length; i += reviewsPerPage) {
        const pageTickets = ticketsWithFeedback.slice(i, i + reviewsPerPage);
        const embed = new EmbedBuilder()
            .setTitle(`📝 Reviews Detail (${Math.floor(i / reviewsPerPage) + 1})`)
            .setColor(getColor('primary'))
            .setTimestamp();

        for (const ticket of pageTickets) {
            const creatorTag = ticket.userId ? `<@${ticket.userId}>` : 'Unknown User';
            const claimerTag = ticket.claimedBy ? `<@${ticket.claimedBy}>` : 'Not claimed';
            const openerTag = ticket.openedBy ? `<@${ticket.openedBy}>` : creatorTag; // fallback
            const closerTag = ticket.closedBy ? `<@${ticket.closedBy}>` : 'Not closed';
            const rating = (typeof ticket.rating === 'number') ? `${ticket.rating}⭐` : skipLabel;
            const comment = ticket.comment || skipLabel;

            const ticketValue = [
                `**Rating:** ${rating}`,
                `**Comment:** ${comment}`,
                `**Opened by:** ${openerTag}`,
                `**Creator:** ${creatorTag}`,
                `**Claimed by:** ${claimerTag}`,
                `**Closed by:** ${closerTag}`,
                `**Created:** <t:${Math.floor(new Date(ticket.createdAt).getTime() / 1000)}:R>`,
                ticket.closedAt ? `**Closed:** <t:${Math.floor(new Date(ticket.closedAt).getTime() / 1000)}:R>` : ''
            ].filter(Boolean).join('\n');

            embed.addFields({ name: `Ticket #${ticket.id.slice(-6).toUpperCase()}`, value: ticketValue, inline: false });
        }

        embeds.push(embed);
    }

    // Send embeds in chunks (Discord up to 10 embeds per message)
    const chunks = [];
    let current = [];
    for (const e of embeds) {
        if (current.length >= 10) { chunks.push(current); current = []; }
        current.push(e);
    }
    if (current.length > 0) chunks.push(current);

    await InteractionHelper.safeEditReply(interaction, { embeds: chunks[0] || [] });
    for (let i = 1; i < chunks.length; i++) {
        await interaction.followUp({ embeds: chunks[i], ephemeral: true });
    }
}

async function handleViewStaff(interaction, staffMember, skipLabel) {
    const allTickets = await getAllTicketsForGuild(interaction.guildId);

    if (!allTickets || allTickets.length === 0) {
        return await InteractionHelper.safeEditReply(interaction, { content: 'No tickets found for this server.' });
    }

    const staffTickets = allTickets.filter(t => t.claimedBy === staffMember.id || t.closedBy === staffMember.id || t.openedBy === staffMember.id || t.userId === staffMember.id);

    if (staffTickets.length === 0) {
        return await InteractionHelper.safeEditReply(interaction, { content: `No tickets found for ${staffMember.username}.` });
    }

    const staffTicketsWithFeedback = staffTickets.filter(t => t.rating !== null || t.comment);
    const numeric = staffTicketsWithFeedback.map(t => (typeof t.rating === 'number' ? t.rating : null)).filter(r => r !== null);
    const avgRating = numeric.length > 0 ? (numeric.reduce((s, r) => s + r, 0) / numeric.length) : 0;

    const summaryEmbed = new EmbedBuilder()
        .setTitle(`📊 ${staffMember.username}'s Ticket Reviews`)
        .setThumbnail(staffMember.displayAvatarURL())
        .setColor(getColor('primary'))
        .setTimestamp()
        .addFields(
            { name: 'Total Tickets Handled', value: String(staffTickets.length), inline: true },
            { name: 'Reviewed Tickets', value: String(staffTicketsWithFeedback.length), inline: true },
            { name: 'Average Rating', value: staffTicketsWithFeedback.length > 0 ? `${avgRating.toFixed(2)}⭐` : 'N/A', inline: true },
            { name: 'Tickets with Ratings', value: String(numeric.length), inline: true },
            { name: 'Tickets with Comments', value: String(staffTicketsWithFeedback.filter(t => t.comment).length), inline: true },
        );

    const embeds = [summaryEmbed];

    // Detailed lists
    const perPage = 5;
    for (let i = 0; i < staffTickets.length; i += perPage) {
        const page = staffTickets.slice(i, i + perPage);
        const embed = new EmbedBuilder()
            .setTitle(`📝 ${staffMember.username}'s Tickets (${Math.floor(i / perPage) + 1})`)
            .setColor(getColor('primary'))
            .setTimestamp();

        for (const ticket of page) {
            const creatorTag = ticket.userId ? `<@${ticket.userId}>` : 'Unknown User';
            const claimerTag = ticket.claimedBy ? `<@${ticket.claimedBy}>` : 'Not claimed';
            const openerTag = ticket.openedBy ? `<@${ticket.openedBy}>` : creatorTag;
            const closerTag = ticket.closedBy ? `<@${ticket.closedBy}>` : 'Not closed';
            const rating = (typeof ticket.rating === 'number') ? `${ticket.rating}⭐` : skipLabel;
            const comment = ticket.comment || skipLabel;

            const ticketValue = [
                `**Rating:** ${rating}`,
                `**Comment:** ${comment}`,
                `**Opened by:** ${openerTag}`,
                `**Creator:** ${creatorTag}`,
                `**Claimed by:** ${claimerTag}`,
                `**Closed by:** ${closerTag}`,
                `**Created:** <t:${Math.floor(new Date(ticket.createdAt).getTime() / 1000)}:R>`,
                ticket.closedAt ? `**Closed:** <t:${Math.floor(new Date(ticket.closedAt).getTime() / 1000)}:R>` : ''
            ].filter(Boolean).join('\n');

            embed.addFields({ name: `Ticket #${ticket.id.slice(-6).toUpperCase()}`, value: ticketValue, inline: false });
        }

        embeds.push(embed);
    }

    // Send embeds in chunks
    const chunks = [];
    let current = [];
    for (const e of embeds) {
        if (current.length >= 10) { chunks.push(current); current = []; }
        current.push(e);
    }
    if (current.length > 0) chunks.push(current);

    await InteractionHelper.safeEditReply(interaction, { embeds: chunks[0] || [] });
    for (let i = 1; i < chunks.length; i++) {
        await interaction.followUp({ embeds: chunks[i], ephemeral: true });
    }
}
