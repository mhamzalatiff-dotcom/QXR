import { getColor } from '../../config/bot.js';
import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { getAllTicketsForGuild } from '../../utils/database.js';
import { botConfig } from '../../config/bot.js';

export default {
    data: new SlashCommandBuilder()
        .setName("reviewdashboard")
        .setDescription("View ticket review statistics and ratings (staff dashboard)")
        .setDMPermission(false)
        .addSubcommand((subcommand) =>
            subcommand
                .setName("all")
                .setDescription("View all ticket reviews"),
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName("staff")
                .setDescription("View reviews for a specific staff member")
                .addUserOption((option) =>
                    option
                        .setName("member")
                        .setDescription("The staff member to view stats for")
                        .setRequired(true),
                ),
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName("me")
                .setDescription("View your own review statistics"),
        ),

    async execute(interaction, guildConfig, client) {
        const deferred = await InteractionHelper.safeDefer(interaction);
        if (!deferred) return;

        // Permission check: administrator or allowed role from botConfig
        const allowedRoles = botConfig.reviewSystem?.allowedRoles || [];
        const hasPermission =
            interaction.memberPermissions.has(PermissionFlagsBits.Administrator) ||
            (allowedRoles.length > 0 && interaction.member.roles.cache.some(role => allowedRoles.includes(role.id)));

        if (!hasPermission) {
            return await replyUserError(interaction, {
                type: ErrorTypes.PERMISSION,
                message: "You don't have permission to use this command. Only admins or allowed roles can view the review dashboard."
            });
        }

        const subcommand = interaction.options.getSubcommand();
        const skipLabel = botConfig.reviewSystem?.skipLabel || "Skipped";

        try {
            if (subcommand === "all") {
                await handleViewAll(interaction, skipLabel);
            } else if (subcommand === "staff") {
                const member = interaction.options.getUser("member");
                await handleViewStaff(interaction, member, skipLabel);
            } else if (subcommand === "me") {
                await handleViewStaff(interaction, interaction.user, skipLabel);
            }
        } catch (error) {
            logger.error('Error executing reviewdashboard command:', {
                error: error.message,
                stack: error.stack,
                guildId: interaction.guildId,
                userId: interaction.user.id,
            });

            await replyUserError(interaction, {
                type: ErrorTypes.VALIDATION,
                message: "An error occurred while retrieving review statistics."
            });
        }
    }
};

async function handleViewAll(interaction, skipLabel) {
    const allTickets = await getAllTicketsForGuild(interaction.guildId);

    if (!allTickets || allTickets.length === 0) {
        return await InteractionHelper.safeEditReply(interaction, { content: "No tickets found for this server." });
    }

    const ticketsWithFeedback = allTickets.filter(t => t.rating != null || t.comment);
    if (ticketsWithFeedback.length === 0) {
        return await InteractionHelper.safeEditReply(interaction, { content: "No ticket reviews found yet." });
    }

    const embeds = [];

    const summaryEmbed = new EmbedBuilder()
        .setTitle("📊 Ticket Review Statistics - All Reviews")
        .setColor(getColor('info'))
        .setTimestamp();

    const avgRating = ticketsWithFeedback.reduce((sum, t) => sum + (t.rating || 0), 0) / ticketsWithFeedback.length;
    const ratedCount = ticketsWithFeedback.filter(t => t.rating != null).length;
    const commentedCount = ticketsWithFeedback.filter(t => t.comment).length;

    summaryEmbed.addFields(
        { name: "Total Reviewed Tickets", value: ticketsWithFeedback.length.toString(), inline: true },
        { name: "Average Rating", value: (Number.isFinite(avgRating) ? avgRating.toFixed(2) + "⭐" : "N/A"), inline: true },
        { name: "Tickets with Ratings", value: ratedCount.toString(), inline: true },
        { name: "Tickets with Comments", value: commentedCount.toString(), inline: true },
    );

    embeds.push(summaryEmbed);

    const reviewsPerPage = 5;
    for (let i = 0; i < ticketsWithFeedback.length; i += reviewsPerPage) {
        const pageTickets = ticketsWithFeedback.slice(i, i + reviewsPerPage);
        const embed = new EmbedBuilder()
            .setTitle(`📝 Ticket Reviews (${Math.floor(i / reviewsPerPage) + 1})`)
            .setColor(getColor('primary'))
            .setTimestamp();

        for (const ticket of pageTickets) {
            const creatorTag = ticket.userId ? `<@${ticket.userId}>` : "Unknown User";
            const claimerTag = ticket.claimedBy ? `<@${ticket.claimedBy}>` : "Not claimed";
            const closerTag = ticket.closedBy ? `<@${ticket.closedBy}>` : "Not closed";
            const rating = ticket.rating ? `${ticket.rating}⭐` : skipLabel;
            const comment = ticket.comment || skipLabel;

            const ticketValue = [
                `**Rating:** ${rating}`,
                `**Comment:** ${comment}`,
                `**Creator:** ${creatorTag}`,
                `**Claimed by:** ${claimerTag}`,
                `**Closed by:** ${closerTag}`,
                `**Created:** <t:${Math.floor(new Date(ticket.createdAt).getTime() / 1000)}:R>`,
                ticket.closedAt ? `**Closed:** <t:${Math.floor(new Date(ticket.closedAt).getTime() / 1000)}:R>` : ""
            ].filter(Boolean).join('\n');

            embed.addFields({ name: `Ticket #${ticket.id.slice(-6).toUpperCase()}`, value: ticketValue, inline: false });
        }

        embeds.push(embed);
    }

    // Send in chunks
    const chunks = [];
    let currentChunk = [];
    for (const embed of embeds) {
        if (currentChunk.length >= 10) { chunks.push(currentChunk); currentChunk = []; }
        currentChunk.push(embed);
    }
    if (currentChunk.length > 0) chunks.push(currentChunk);

    await InteractionHelper.safeEditReply(interaction, { embeds: chunks[0] || [] });
    for (let i = 1; i < chunks.length; i++) {
        await interaction.followUp({ embeds: chunks[i], ephemeral: true });
    }
}

async function handleViewStaff(interaction, staffMember, skipLabel) {
    const allTickets = await getAllTicketsForGuild(interaction.guildId);

    if (!allTickets || allTickets.length === 0) {
        return await InteractionHelper.safeEditReply(interaction, { content: "No tickets found for this server." });
    }

    const staffTickets = allTickets.filter(t => t.claimedBy === staffMember.id || t.closedBy === staffMember.id);
    if (staffTickets.length === 0) {
        return await InteractionHelper.safeEditReply(interaction, { content: `No tickets found for ${staffMember.username}.` });
    }

    const staffTicketsWithFeedback = staffTickets.filter(t => t.rating != null || t.comment);

    // Compute average rating only from tickets with rating
    const ratedTickets = staffTickets.filter(t => t.rating != null && Number.isFinite(Number(t.rating)));
    const avgRating = ratedTickets.length > 0
        ? ratedTickets.reduce((sum, t) => sum + Number(t.rating), 0) / ratedTickets.length
        : null;

    const ratedCount = staffTicketsWithFeedback.filter(t => t.rating != null).length;
    const commentedCount = staffTicketsWithFeedback.filter(t => t.comment).length;

    const summaryEmbed = new EmbedBuilder()
        .setTitle(`📊 ${staffMember.username}'s Ticket Statistics`)
        .setThumbnail(staffMember.displayAvatarURL())
        .setColor(getColor('primary'))
        .setTimestamp();

    summaryEmbed.addFields(
        { name: "Total Tickets Handled", value: staffTickets.length.toString(), inline: true },
        { name: "Reviewed Tickets", value: staffTicketsWithFeedback.length.toString(), inline: true },
        { name: "Average Rating", value: avgRating !== null ? avgRating.toFixed(2) + "⭐" : "N/A", inline: true },
        { name: "Tickets with Ratings", value: ratedCount.toString(), inline: true },
        { name: "Tickets with Comments", value: commentedCount.toString(), inline: true },
        { name: "Skipped Reviews", value: (staffTickets.length - staffTicketsWithFeedback.length).toString(), inline: true },
    );

    const embeds = [summaryEmbed];

    const reviewsPerPage = 5;
    for (let i = 0; i < staffTickets.length; i += reviewsPerPage) {
        const pageTickets = staffTickets.slice(i, i + reviewsPerPage);
        const embed = new EmbedBuilder()
            .setTitle(`📝 ${staffMember.username}'s Tickets (${Math.floor(i / reviewsPerPage) + 1})`)
            .setColor(getColor('primary'))
            .setTimestamp();

        for (const ticket of pageTickets) {
            const creatorTag = ticket.userId ? `<@${ticket.userId}>` : "Unknown User";
            const rating = ticket.rating ? `${ticket.rating}⭐` : skipLabel;
            const comment = ticket.comment || skipLabel;

            const ticketValue = [
                `**Rating:** ${rating}`,
                `**Comment:** ${comment}`,
                `**Creator:** ${creatorTag}`,
                `**Created:** <t:${Math.floor(new Date(ticket.createdAt).getTime() / 1000)}:R>`,
                ticket.closedAt ? `**Closed:** <t:${Math.floor(new Date(ticket.closedAt).getTime() / 1000)}:R>` : ""
            ].filter(Boolean).join('\n');

            embed.addFields({ name: `Ticket #${ticket.id.slice(-6).toUpperCase()}`, value: ticketValue, inline: false });
        }

        embeds.push(embed);
    }

    // Send in chunks
    const chunks = [];
    let currentChunk = [];
    for (const embed of embeds) {
        if (currentChunk.length >= 10) { chunks.push(currentChunk); currentChunk = []; }
        currentChunk.push(embed);
    }
    if (currentChunk.length > 0) chunks.push(currentChunk);

    await InteractionHelper.safeEditReply(interaction, { embeds: chunks[0] || [] });
    for (let i = 1; i < chunks.length; i++) {
        await interaction.followUp({ embeds: chunks[i], ephemeral: true });
    }
}
