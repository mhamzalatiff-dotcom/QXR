import { getColor } from '../../../config/bot.js';
import {
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    RoleSelectMenuBuilder,
    ChannelSelectMenuBuilder,
    UserSelectMenuBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    MessageFlags,
    ComponentType,
    EmbedBuilder,
} from 'discord.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { successEmbed, infoEmbed } from '../../../utils/embeds.js';
import { logger } from '../../../utils/logger.js';
import { TitanBotError, ErrorTypes, replyUserError } from '../../../utils/errorHandler.js';
import { getGuildConfig, setGuildConfig } from '../../../services/config/guildConfig.js';
import { getGuildTicketStats } from '../../../utils/database/tickets.js';
import { getUserTicketCount } from '../../../services/ticket.js';
import {
    getTicketPanelStatus,
    messageHasButtonCustomId,
    formatPanelStatusField,
} from '../../../utils/panelStatus.js';
import { startDashboardSession } from '../../../utils/dashboardSession.js';

function buildButtonRow(guildConfig, guildId, disabled = false, panelStatus = null) {
    const dmEnabled = guildConfig.dmOnClose !== false;
    const showRepost = panelStatus?.exists === false && panelStatus?.reason === 'panel_deleted';

    const buttons = [];

    if (showRepost) {
        buttons.push(
            new ButtonBuilder()
                .setCustomId(`ticket_cfg_repost_${guildId}`)
                .setLabel('Repost Panel')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('📌')
                .setDisabled(disabled),
        );
    }

    buttons.push(
        new ButtonBuilder()
            .setCustomId(`ticket_cfg_dm_toggle_${guildId}`)
            .setLabel('DM on Close')
            .setStyle(dmEnabled ? ButtonStyle.Success : ButtonStyle.Danger)
            .setEmoji(dmEnabled ? '📬' : '📭')
            .setDisabled(disabled),
        new ButtonBuilder()
            .setCustomId(`ticket_cfg_staff_role_btn_${guildId}`)
            .setLabel('Staff Role')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('🛡️')
            .setDisabled(disabled),
        new ButtonBuilder()
            .setCustomId(`ticket_cfg_delete_${guildId}`)
            .setLabel('Delete System')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('🗑️')
            .setDisabled(disabled),
    );

    return new ActionRowBuilder().addComponents(buttons);
}

async function persistPanelMessageId(client, guildId, guildConfig, messageId) {
    if (!messageId || guildConfig.ticketPanelMessageId === messageId) return;
    guildConfig.ticketPanelMessageId = messageId;
    if (client.db) {
        await setGuildConfig(client, guildId, guildConfig);
    }
}

function buildPanelEmbed(config) {
    return new EmbedBuilder()
        .setTitle('Support Tickets')
        .setDescription(config.ticketPanelMessage || 'Click the button below to create a support ticket.')
        .setColor(getColor('info'));
}

function buildPanelButtonRow(config) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('create_ticket')
            .setLabel(config.ticketButtonLabel || 'Create Ticket')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('📩'),
    );
}

async function repostTicketPanel(client, guild, guildConfig, guildId) {
    const channel = await guild.channels.fetch(guildConfig.ticketPanelChannelId).catch(() => null);
    if (!channel) {
        throw new TitanBotError(
            'Panel channel missing',
            ErrorTypes.CONFIGURATION,
            'The configured ticket panel channel no longer exists. Set a new panel channel from the dashboard.',
        );
    }

    const sentPanel = await channel.send({
        embeds: [buildPanelEmbed(guildConfig)],
        components: [buildPanelButtonRow(guildConfig)],
    });

    await persistPanelMessageId(client, guildId, guildConfig, sentPanel.id);
    return sentPanel;
}

function formatCloseDuration(ms) {
    if (ms == null) return '`N/A`';
    const hours = Math.floor(ms / 3_600_000);
    const minutes = Math.floor((ms % 3_600_000) / 60_000);
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}

function buildDashboardEmbed(config, guild, panelStatus = null, ticketStats = null) {
    const panelChannel = config.ticketPanelChannelId ? `<#${config.ticketPanelChannelId}>` : '`Not set`';
    const staffRole = config.ticketStaffRoleId ? `<@&${config.ticketStaffRoleId}>` : '`Not set`';
    const ticketLogsChannel = config.ticketLogsChannelId ? `<#${config.ticketLogsChannelId}>` : '`Not set`';
    const transcriptChannel = config.ticketTranscriptChannelId ? `<#${config.ticketTranscriptChannelId}>` : '`Not set`';

    const openCategoryChannel = config.ticketCategoryId ? guild.channels.cache.get(config.ticketCategoryId) : null;
    const openCategory = openCategoryChannel ? openCategoryChannel.toString() : '`Not set`';
    
    const closedCategoryChannel = config.ticketClosedCategoryId ? guild.channels.cache.get(config.ticketClosedCategoryId) : null;
    const closedCategory = closedCategoryChannel ? closedCategoryChannel.toString() : '`Not set`';

    const rawMsg = config.ticketPanelMessage || 'Click the button below to create a support ticket.';
    const panelMsg = `\`${rawMsg.length > 60 ? rawMsg.substring(0, 60) + '…' : rawMsg}\``;
    const btnLabel = `\`${config.ticketButtonLabel || 'Create Ticket'}\``;

    let panelStatusValue = formatPanelStatusField(panelStatus);

    const openTickets = ticketStats ? String(ticketStats.openCount) : '`—`';
    const avgCloseTime = ticketStats ? formatCloseDuration(ticketStats.avgCloseTimeMs) : '`—`';
    const feedbackSummary = ticketStats?.feedbackCount
        ? `${ticketStats.avgRating}/5 (${ticketStats.feedbackCount} rating${ticketStats.feedbackCount !== 1 ? 's' : ''})`
        : '`No ratings yet`';

    return new EmbedBuilder()
        .setTitle('🎫 Ticket System Dashboard')
        .setDescription(`Manage ticket system settings for **${guild.name}**.\nSelect an option below to modify a setting.`)
        .setColor(getColor('info'))
        .addFields(
            { name: 'Panel Status', value: panelStatusValue, inline: false },
            { name: 'Panel Channel', value: panelChannel, inline: true },
            { name: 'Staff Role', value: staffRole, inline: true },
            { name: '\u200B', value: '\u200B', inline: true },
            { name: 'Open Tickets Category', value: openCategory, inline: true },
            { name: 'Closed Tickets Category', value: closedCategory, inline: true },
            { name: '\u200B', value: '\u200B', inline: true },
            { name: 'Panel Message', value: panelMsg, inline: false },
            { name: 'Button Label', value: btnLabel, inline: true },
            { name: 'Max Tickets/User', value: String(config.maxTicketsPerUser || 3), inline: true },
            { name: 'DM on Close', value: config.dmOnClose !== false ? 'Enabled' : 'Disabled', inline: true },
            { name: 'Ticket Logs Channel', value: ticketLogsChannel, inline: true },
            { name: 'Transcript Channel', value: transcriptChannel, inline: true },
            { name: '\u200B', value: '\u200B', inline: true },
            { name: 'Open Tickets', value: openTickets, inline: true },
            { name: 'Avg Close Time', value: avgCloseTime, inline: true },
            { name: 'Feedback Rating', value: feedbackSummary, inline: true },
        )
        .setFooter({ text: 'Select an option below • Dashboard closes after 10 minutes of inactivity' })
        .setTimestamp();
}

function buildSelectMenu(guildId) {
    return new StringSelectMenuBuilder()
        .setCustomId(`ticket_config_${guildId}`)
        .setPlaceholder('Select a setting to configure...')
        .addOptions(
            new StringSelectMenuOptionBuilder()
                .setLabel('Edit Panel Message')
                .setDescription('Change the message displayed on the ticket creation panel')
                .setValue('panel_message')
                .setEmoji('📝'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Edit Button Label')
                .setDescription('Change the label on the Create Ticket button')
                .setValue('button_label')
                .setEmoji('🏷️'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Change Open Tickets Category')
                .setDescription('Category where new tickets are created')
                .setValue('open_category')
                .setEmoji('📁'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Change Closed Tickets Category')
                .setDescription('Category where closed tickets are moved')
                .setValue('closed_category')
                .setEmoji('📂'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Set Max Tickets per User')
                .setDescription('Limit how many open tickets one user can have at once')
                .setValue('max_tickets')
                .setEmoji('🔢'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Set Ticket Logs Channel')
                .setDescription('Channel to receive ticket feedback, lifecycle events, and logs')
                .setValue('logs_channel')
                .setEmoji('🎫'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Set Transcript Channel')
                .setDescription('Channel to receive auto-generated transcripts on deletion')
                .setValue('transcript_channel')
                .setEmoji('📜'),
            // Priority Settings option
            new StringSelectMenuOptionBuilder()
                .setLabel('Priority Settings')
                .setDescription('Configure how priority tickets are organized (single or per-level)')
                .setValue('priority_settings')
                .setEmoji('📌'),
        );
}

async function refreshDashboard(rootInteraction, guildConfig, guildId, client) {
    const panelStatus = client
        ? await getTicketPanelStatus(client, rootInteraction.guild, guildConfig)
        : null;
    const ticketStats = client ? await getGuildTicketStats(guildId) : null;

    if (panelStatus?.recoveredId) {
        await persistPanelMessageId(client, guildId, guildConfig, panelStatus.recoveredId);
    }

    const buttonRow = buildButtonRow(guildConfig, guildId, false, panelStatus);
    const selectRow = new ActionRowBuilder().addComponents(buildSelectMenu(guildId));
    await InteractionHelper.safeEditReply(rootInteraction, {
        embeds: [buildDashboardEmbed(guildConfig, rootInteraction.guild, panelStatus, ticketStats)],
        components: [buttonRow, selectRow],
    }).catch(() => {});
}

async function updateLivePanel(client, guild, config, guildId) {
    if (!config.ticketPanelChannelId) return false;
    try {
        const panelStatus = await getTicketPanelStatus(client, guild, config);
        if (panelStatus.recoveredId) {
            await persistPanelMessageId(client, guildId, config, panelStatus.recoveredId);
        }
        if (!panelStatus.exists || !panelStatus.message) return false;

        await panelStatus.message.edit({
            embeds: [buildPanelEmbed(config)],
            components: [buildPanelButtonRow(config)],
        });
        return true;
    } catch (error) {
        logger.warn('Failed to update live ticket panel:', error.message);
        return false;
    }
}

export default {
    prefixOnly: false,
    async execute(interaction, config, client) {
        try {
            const guildId = interaction.guild.id;
            const guildConfig = await getGuildConfig(client, guildId);

            if (!guildConfig.ticketPanelChannelId) {
                throw new TitanBotError(
                    'Ticket system not configured',
                    ErrorTypes.CONFIGURATION,
                    'The ticket system has not been set up yet. Run `/ticket setup` first to configure it.',
                );
            }

            const panelStatus = await getTicketPanelStatus(client, interaction.guild, guildConfig);
            if (panelStatus.recoveredId) {
                await persistPanelMessageId(client, guildId, guildConfig, panelStatus.recoveredId);
            }

            const ticketStats = await getGuildTicketStats(guildId);

            const selectRow = new ActionRowBuilder().addComponents(buildSelectMenu(guildId));
            const buttonRow = buildButtonRow(guildConfig, guildId, false, panelStatus);

            await startDashboardSession({
                interaction,
                embeds: [buildDashboardEmbed(guildConfig, interaction.guild, panelStatus, ticketStats)],
                components: [buttonRow, selectRow],
                selectMenuId: `ticket_config_${guildId}`,
                buttonMatcher: (customId) =>
                    customId === `ticket_cfg_repost_${guildId}` ||
                    customId === `ticket_cfg_dm_toggle_${guildId}` ||
                    customId === `ticket_cfg_staff_role_btn_${guildId}` ||
                    customId === `ticket_cfg_delete_${guildId}`,
                onSelect: async (selectInteraction) => {
                    const selectedOption = selectInteraction.values[0];
                    switch (selectedOption) {
                        case 'panel_message':
                            await handlePanelMessage(selectInteraction, interaction, guildConfig, guildId, client);
                            break;
                        case 'button_label':
                            await handleButtonLabel(selectInteraction, interaction, guildConfig, guildId, client);
                            break;
                        case 'staff_role':
                            await handleStaffRole(selectInteraction, interaction, guildConfig, guildId, client);
                            break;
                        case 'open_category':
                            await handleOpenCategory(selectInteraction, interaction, guildConfig, guildId, client);
                            break;
                        case 'closed_category':
                            await handleClosedCategory(selectInteraction, interaction, guildConfig, guildId, client);
                            break;
                        case 'max_tickets':
                            await handleMaxTickets(selectInteraction, interaction, guildConfig, guildId, client);
                            break;
                        case 'logs_channel':
                            await handleLogsChannel(selectInteraction, interaction, guildConfig, guildId, client);
                            break;
                        case 'transcript_channel':
                            await handleTranscriptChannel(selectInteraction, interaction, guildConfig, guildId, client);
                            break;
+                        case 'priority_settings':
+                            await handlePrioritySettings(selectInteraction, interaction, guildConfig, guildId, client);
+                            break;
                    }
                },
                onButton: async (btnInteraction) => {
                    if (btnInteraction.customId === `ticket_cfg_repost_${guildId}`) {
                        await handleRepostPanel(btnInteraction, interaction, guildConfig, guildId, client);
                    } else if (btnInteraction.customId === `ticket_cfg_dm_toggle_${guildId}`) {
                        await handleDmOnClose(btnInteraction, interaction, guildConfig, guildId, client);
                    } else if (btnInteraction.customId === `ticket_cfg_staff_role_btn_${guildId}`) {
                        await handleStaffRole(btnInteraction, interaction, guildConfig, guildId, client);
                    } else if (btnInteraction.customId === `ticket_cfg_delete_${guildId}`) {
                        await handleDeleteSystem(btnInteraction, interaction, guildConfig, guildId, client);
                    }
                },
            });
        } catch (error) {
            if (error instanceof TitanBotError) throw error;
            logger.error('Unexpected error in ticket_config:', error);
            throw new TitanBotError(
                `Ticket config failed: ${error.message}`,
                ErrorTypes.UNKNOWN,
                'Failed to open the ticket configuration dashboard.',
            );
        }
    },
};

async function handlePanelMessage(selectInteraction, rootInteraction, guildConfig, guildId, client) {
    const modal = new ModalBuilder()
        .setCustomId('ticket_cfg_panel_msg')
        .setTitle('📝 Edit Panel Message')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('panel_msg_input')
                    .setLabel('Panel Message')
                    .setStyle(TextInputStyle.Paragraph)
                    .setValue(
                        guildConfig.ticketPanelMessage ||
                            'Click the button below to create a support ticket.',
                    )
                    .setMaxLength(2000)
                    .setMinLength(1)
                    .setRequired(true)
                    .setPlaceholder('Click the button below to create a support ticket.'),
            ),
        );

    await selectInteraction.showModal(modal);

    const submitted = await selectInteraction
        .awaitModalSubmit({
            filter: i =>
                i.customId === 'ticket_cfg_panel_msg' && i.user.id === selectInteraction.user.id,
            time: 120_000,
        })
        .catch(() => null);

    if (!submitted) return;

    const newMessage = submitted.fields.getTextInputValue('panel_msg_input').trim();
    guildConfig.ticketPanelMessage = newMessage;
    await setGuildConfig(client, guildId, guildConfig);

    const panelUpdated = await updateLivePanel(client, rootInteraction.guild, guildConfig, guildId);

    await submitted.reply({
        embeds: [
            successEmbed(
                '✅ Panel Message Updated',
                `The panel message has been updated.${
                    panelUpdated
                        ? '\nThe live ticket panel has also been refreshed.'
                        : '\n> **Note:** The live panel could not be located. Use **Repost Panel** on the dashboard to restore it.'
                }`,
            ),
        ],
        flags: MessageFlags.Ephemeral,
    });

    await refreshDashboard(rootInteraction, guildConfig, guildId, client);
}

async function handleButtonLabel(selectInteraction, rootInteraction, guildConfig, guildId, client) {
    const modal = new ModalBuilder()
        .setCustomId('ticket_cfg_btn_label')
        .setTitle('🏷️ Edit Button Label')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('btn_label_input')
                    .setLabel('Button Label (max 80 characters)')
                    .setStyle(TextInputStyle.Short)
                    .setValue(guildConfig.ticketButtonLabel || 'Create Ticket')
                    .setMaxLength(80)
                    .setMinLength(1)
                    .setRequired(true)
                    .setPlaceholder('Create Ticket'),
            ),
        );

    await selectInteraction.showModal(modal);

    const submitted = await selectInteraction
        .awaitModalSubmit({
            filter: i =>
                i.customId === 'ticket_cfg_btn_label' && i.user.id === selectInteraction.user.id,
            time: 120_000,
        })
        .catch(() => null);

    if (!submitted) return;

    const newLabel = submitted.fields.getTextInputValue('btn_label_input').trim();
    guildConfig.ticketButtonLabel = newLabel;
    await setGuildConfig(client, guildId, guildConfig);

    const panelUpdated = await updateLivePanel(client, rootInteraction.guild, guildConfig, guildId);

    await submitted.reply({
        embeds: [
            successEmbed(
                '✅ Button Label Updated',
                `Button label changed to \`${newLabel}\`.` +
                    (panelUpdated
                        ? '\nThe live ticket panel button has also been updated.'
                        : '\n> **Note:** The live panel could not be located. Use **Repost Panel** on the dashboard to restore it.'),
            ),
        ],
        flags: MessageFlags.Ephemeral,
    });

    await refreshDashboard(rootInteraction, guildConfig, guildId, client);
}

async function handleStaffRole(selectInteraction, rootInteraction, guildConfig, guildId, client) {
    await selectInteraction.deferUpdate();

    const roleSelect = new RoleSelectMenuBuilder()
        .setCustomId('ticket_cfg_staff_role')
        .setPlaceholder('Select the staff role...')
        .setMaxValues(1);

    const row = new ActionRowBuilder().addComponents(roleSelect);

    await selectInteraction.followUp({
        embeds: [
            new EmbedBuilder()
                .setTitle('🛡️ Change Staff Role')
                .setDescription(
                    `**Current:** ${guildConfig.ticketStaffRoleId ? `<@&${guildConfig.ticketStaffRoleId}>` : '`Not set`'}\n\nSelect the role that should have staff access to manage tickets.`,
                )
                .setColor(getColor('info')),
        ],
        components: [row],
        flags: MessageFlags.Ephemeral,
    });

    const roleCollector = rootInteraction.channel.createMessageComponentCollector({
        componentType: ComponentType.RoleSelect,
        filter: i =>
            i.user.id === selectInteraction.user.id && i.customId === 'ticket_cfg_staff_role',
        time: 60_000,
        max: 1,
    });

    roleCollector.on('collect', async roleInteraction => {
        await roleInteraction.deferUpdate();
        const role = roleInteraction.roles.first();

        guildConfig.ticketStaffRoleId = role.id;
        await setGuildConfig(client, guildId, guildConfig);

        await roleInteraction.followUp({
            embeds: [successEmbed('Staff Role Updated', `Staff role set to ${role}.`)],
            flags: MessageFlags.Ephemeral,
        });

        await refreshDashboard(rootInteraction, guildConfig, guildId, client);
    });

    roleCollector.on('end', (collected, reason) => {
        if (reason === 'time' && collected.size === 0) {
            replyUserError(selectInteraction, {
                type: ErrorTypes.RATE_LIMIT,
                message: 'No role was selected. The staff role was not changed.',
            }).catch(() => {});
        }
    });
}

async function handleOpenCategory(selectInteraction, rootInteraction, guildConfig, guildId, client) {
    await selectInteraction.deferUpdate();

    const channelSelect = new ChannelSelectMenuBuilder()
        .setCustomId('ticket_cfg_open_cat')
        .setPlaceholder('Select a category...')
        .addChannelTypes(ChannelType.GuildCategory)
        .setMaxValues(1);

    await selectInteraction.followUp({
        embeds: [
            new EmbedBuilder()
                .setTitle('📁 Change Open Tickets Category')
                .setDescription(
                    `**Current:** ${guildConfig.ticketCategoryId ? `<#${guildConfig.ticketCategoryId}>` : '`Not set`'}\n\nSelect the category where new tickets will be created.`,
                )
                .setColor(getColor('info')),
        ],
        components: [new ActionRowBuilder().addComponents(channelSelect)],
        flags: MessageFlags.Ephemeral,
    });

    const catCollector = rootInteraction.channel.createMessageComponentCollector({
        componentType: ComponentType.ChannelSelect,
        filter: i =>
            i.user.id === selectInteraction.user.id && i.customId === 'ticket_cfg_open_cat',
        time: 60_000,
        max: 1,
    });

    catCollector.on('collect', async catInteraction => {
        await catInteraction.deferUpdate();
        const category = catInteraction.channels.first();

        guildConfig.ticketCategoryId = category.id;
        await setGuildConfig(client, guildId, guildConfig);

        await catInteraction.followUp({
            embeds: [
                successEmbed(
                    'Open Category Updated',
                    `New tickets will now be created in **${category.name}**.`,
                ),
            ],
            flags: MessageFlags.Ephemeral,
        });

        await refreshDashboard(rootInteraction, guildConfig, guildId, client);
    });

    catCollector.on('end', (collected, reason) => {
        if (reason === 'time' && collected.size === 0) {
            replyUserError(selectInteraction, {
                type: ErrorTypes.RATE_LIMIT,
                message: 'No category was selected. The setting was not changed.',
            }).catch(() => {});
        }
    });
}

async function handleClosedCategory(selectInteraction, rootInteraction, guildConfig, guildId, client) {
    await selectInteraction.deferUpdate();

    const channelSelect = new ChannelSelectMenuBuilder()
        .setCustomId('ticket_cfg_closed_cat')
        .setPlaceholder('Select a category...')
        .addChannelTypes(ChannelType.GuildCategory)
        .setMaxValues(1);

    await selectInteraction.followUp({
        embeds: [
            new EmbedBuilder()
                .setTitle('📂 Change Closed Tickets Category')
                .setDescription(
                    `**Current:** ${guildConfig.ticketClosedCategoryId ? `<#${guildConfig.ticketClosedCategoryId}>` : '`Not set`'}\n\nSelect the category where closed tickets will be moved.`,
                )
                .setColor(getColor('info')),
        ],
        components: [new ActionRowBuilder().addComponents(channelSelect)],
        flags: MessageFlags.Ephemeral,
    });

    const catCollector = rootInteraction.channel.createMessageComponentCollector({
        componentType: ComponentType.ChannelSelect,
        filter: i =>
(The file content was long; tool truncated?)