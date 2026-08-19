import { getColor } from '../../config/bot.js';
import { SlashCommandBuilder, PermissionFlagsBits, PermissionsBitField, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { createEmbed, successEmbed, infoEmbed, warningEmbed } from '../../utils/embeds.js';
import { getGuildConfig, setGuildConfig } from '../../services/config/guildConfig.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { logger } from '../../utils/logger.js';
import { handleInteractionError, replyUserError, ErrorTypes } from '../../utils/errorHandler.js';

import ticketConfig from './modules/ticket_dashboard.js';

export default {
    data: new SlashCommandBuilder()
        .setName("ticket")
        .setDescription("Manages the server's ticket system.")
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
        .addSubcommand((subcommand) =>
            subcommand
                .setName("setup")
                .setDescription(
                    "Sets up the ticket creation panel in a specified channel.",
                )
                .addChannelOption((option) =>
                    option
                        .setName("panel_channel")
                        .setDescription(
                            "The channel where the ticket panel will be sent.",
                        )
                        .addChannelTypes(ChannelType.GuildText)
                        .setRequired(true),
                )
                .addStringOption((option) =>
                    option
                        .setName("panel_message")
                        .setDescription(
                            "The main message/description for the ticket panel.",
                        )
                        .setRequired(true),
                )
                .addStringOption((option) =>
                    option
                        .setName("panel_image_url")
                        .setDescription(
                            "Image URL to display in the ticket panel (optional).",
                        )
                        .setRequired(false),
                )
                .addStringOption((option) =>
                    option
                        .setName("panel_footer")
                        .setDescription(
                            "Footer text for the ticket panel (optional).",
                        )
                        .setRequired(false),
                )
                .addChannelOption((option) =>
                    option
                        .setName("category")
                        .setDescription(
                            "The category where new tickets will be created (optional).",
                        )
                        .addChannelTypes(ChannelType.GuildCategory)
                        .setRequired(false),
                )
                .addChannelOption((option) =>
                    option
                        .setName("priority_dashboard_category")
                        .setDescription(
                            "The category where priority-organized tickets will be moved (optional).",
                        )
                        .addChannelTypes(ChannelType.GuildCategory)
                        .setRequired(false),
                )
                .addChannelOption((option) =>
                    option
                        .setName("closed_category")
                        .setDescription(
                            "The category where closed tickets will be moved (optional).",
                        )
                        .addChannelTypes(ChannelType.GuildCategory)
                        .setRequired(false),
                )
                .addRoleOption((option) =>
                    option
                        .setName("staff_role")
                        .setDescription(
                            "The role that can access tickets (optional).",
                        )
                        .setRequired(false),
                )
                .addIntegerOption((option) =>
                    option
                        .setName("max_tickets_per_user")
                        .setDescription("Maximum number of tickets a user can create (default: 3)")
                        .setMinValue(1)
                        .setMaxValue(10)
                        .setRequired(false),
                )
                .addBooleanOption((option) =>
                    option
                        .setName("dm_on_close")
                        .setDescription("Send DM to user when their ticket is closed (default: true)")
                        .setRequired(false),
                )
                .addIntegerOption((option) =>
                    option
                        .setName("button_count")
                        .setDescription("Number of custom ticket creation buttons (1-5, default: 1)")
                        .setMinValue(1)
                        .setMaxValue(5)
                        .setRequired(false),
                )
                .addStringOption((option) =>
                    option
                        .setName("button_1_label")
                        .setDescription("Label for button 1")
                        .setRequired(false),
                )
                .addStringOption((option) =>
                    option
                        .setName("button_2_label")
                        .setDescription("Label for button 2")
                        .setRequired(false),
                )
                .addStringOption((option) =>
                    option
                        .setName("button_3_label")
                        .setDescription("Label for button 3")
                        .setRequired(false),
                )
                .addStringOption((option) =>
                    option
                        .setName("button_4_label")
                        .setDescription("Label for button 4")
                        .setRequired(false),
                )
                .addStringOption((option) =>
                    option
                        .setName("button_5_label")
                        .setDescription("Label for button 5")
                        .setRequired(false),
                ),
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName("dashboard")
                .setDescription("Open the interactive ticket system dashboard"),
        ),
    category: "ticket",

    async execute(interaction, config, client) {
        const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferred) {
            return;
        }

        if (
            !interaction.member.permissions.has(
                PermissionFlagsBits.ManageChannels,
            )
        ) {
            logger.warn('Ticket command permission denied', {
                userId: interaction.user.id,
                guildId: interaction.guildId,
                commandName: 'ticket'
            });
            return await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'You need the `Manage Channels` permission for this action.' });
        }

        const subcommand = interaction.options.getSubcommand();

        if (subcommand === "dashboard") {
            return ticketConfig.execute(interaction, config, client);
        }

        if (subcommand === "setup") {
            const existingConfig = await getGuildConfig(client, interaction.guildId);
            if (existingConfig?.ticketPanelChannelId) {
                return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: `This server already has a ticket system set up (panel in <#${existingConfig.ticketPanelChannelId}>). Please reset it first.` });
            }

            const panelChannel = interaction.options.getChannel("panel_channel");
            const categoryChannel = interaction.options.getChannel("category");
            const priorityDashboardCategory = interaction.options.getChannel("priority_dashboard_category");
            const closedCategoryChannel = interaction.options.getChannel("closed_category");
            const staffRole = interaction.options.getRole("staff_role");
            const panelMessage = interaction.options.getString("panel_message") || "Click a button below to create a support ticket.";
            const panelImageUrl = interaction.options.getString("panel_image_url") || null;
            const panelFooter = interaction.options.getString("panel_footer") || null;
            const maxTicketsPerUser = interaction.options.getInteger("max_tickets_per_user") || 3;
            const dmOnClose = interaction.options.getBoolean("dm_on_close") !== false;
            const buttonCount = interaction.options.getInteger("button_count") || 1;

            // Collect button labels
            const buttonLabels = [];
            for (let i = 1; i <= buttonCount; i++) {
                const label = interaction.options.getString(`button_${i}_label`);
                buttonLabels.push(label || `Ticket Type ${i}`);
            }

            const setupEmbed = createEmbed({ 
                title: "Support Tickets", 
                description: panelMessage,
                color: getColor('info'),
                image: panelImageUrl ? { url: panelImageUrl } : undefined,
                footer: panelFooter ? { text: panelFooter } : undefined,
            });

            const ticketButtonRows = [];
            let currentRow = new ActionRowBuilder();
            
            for (let i = 0; i < buttonLabels.length; i++) {
                if (currentRow.components.length >= 5) {
                    ticketButtonRows.push(currentRow);
                    currentRow = new ActionRowBuilder();
                }
                
                currentRow.addComponents(
                    new ButtonBuilder()
                        .setCustomId(`create_ticket_type:${i}`)
                        .setLabel(buttonLabels[i])
                        .setStyle(ButtonStyle.Primary)
                        .setEmoji("📩"),
                );
            }
            
            if (currentRow.components.length > 0) {
                ticketButtonRows.push(currentRow);
            }

            try {
                const sentPanel = await panelChannel.send({
                    embeds: [setupEmbed],
                    components: ticketButtonRows,
                });

                if (client.db && interaction.guildId) {
                    const currentConfig = existingConfig || {};
                    currentConfig.ticketCategoryId = categoryChannel ? categoryChannel.id : null;
                    currentConfig.ticketPriorityDashboardCategoryId = priorityDashboardCategory ? priorityDashboardCategory.id : null;
                    currentConfig.ticketClosedCategoryId = closedCategoryChannel ? closedCategoryChannel.id : null;
                    currentConfig.ticketStaffRoleId = staffRole ? staffRole.id : null;
                    currentConfig.ticketPanelChannelId = panelChannel.id;
                    currentConfig.ticketPanelMessageId = sentPanel?.id || null;
                    currentConfig.ticketPanelMessage = panelMessage;
                    currentConfig.ticketPanelImageUrl = panelImageUrl;
                    currentConfig.ticketPanelFooter = panelFooter;
                    currentConfig.ticketButtonCount = buttonCount;
                    currentConfig.ticketButtonLabels = buttonLabels;
                    currentConfig.maxTicketsPerUser = maxTicketsPerUser;
                    currentConfig.dmOnClose = dmOnClose;

                    await setGuildConfig(client, interaction.guildId, currentConfig);
                    logger.info('Ticket configuration saved', {
                        guildId: interaction.guildId,
                        categoryId: categoryChannel?.id,
                        priorityDashboardCategoryId: priorityDashboardCategory?.id,
                        closedCategoryId: closedCategoryChannel?.id,
                        staffRoleId: staffRole?.id,
                        maxTickets: maxTicketsPerUser,
                        dmOnClose: dmOnClose,
                        buttonCount: buttonCount,
                        buttonLabels: buttonLabels,
                    });
                } else {
                    logger.error('Ticket setup: database unavailable, panel sent but configuration was NOT saved', {
                        guildId: interaction.guildId,
                    });
                }

                let successMessage = `The ticket creation panel has been sent to ${panelChannel}.\n\n`;
                
                if (categoryChannel) {
                    successMessage += `✅ New tickets will be created in the **${categoryChannel.name}** category.\n`;
                } else {
                    successMessage += '✅ New tickets will be created in a new "Tickets" category.\n';
                }
                
                if (priorityDashboardCategory) {
                    successMessage += `✅ Priority-sorted tickets will be organized in **${priorityDashboardCategory.name}**.\n`;
                }
                
                if (closedCategoryChannel) {
                    successMessage += `✅ Closed tickets will be moved to **${closedCategoryChannel.name}**.\n`;
                }
                
                if (staffRole) {
                    successMessage += `✅ **${staffRole.name}** role will have access to tickets.\n`;
                }
                
                successMessage += `\n**Configuration:**\n`;
                successMessage += `• Max Tickets Per User: ${maxTicketsPerUser}\n`;
                successMessage += `• DM on Close: ${dmOnClose ? 'Enabled' : 'Disabled'}\n`;
                successMessage += `• Custom Buttons: ${buttonCount}\n`;
                if (panelImageUrl) successMessage += `• Panel Image: Set ✓\n`;
                if (panelFooter) successMessage += `• Panel Footer: "${panelFooter}"\n`;

                await InteractionHelper.safeEditReply(interaction, {
                    embeds: [
                        successEmbed(
                            "Ticket Panel Set Up",
                            successMessage,
                        ),
                    ],
                });

                logger.info('Ticket panel setup completed', {
                    userId: interaction.user.id,
                    userTag: interaction.user.tag,
                    guildId: interaction.guildId,
                    panelChannelId: panelChannel.id,
                    categoryId: categoryChannel?.id,
                    priorityDashboardCategoryId: priorityDashboardCategory?.id,
                    closedCategoryId: closedCategoryChannel?.id,
                    staffRoleId: staffRole?.id,
                    maxTickets: maxTicketsPerUser,
                    dmOnClose: dmOnClose,
                    buttonCount: buttonCount,
                    commandName: 'ticket_setup'
                });

            } catch (error) {
                logger.error('Ticket setup error', {
                    error: error.message,
                    stack: error.stack,
                    userId: interaction.user.id,
                    guildId: interaction.guildId,
                    commandName: 'ticket_setup'
                });
                if (interaction.deferred || interaction.replied) {
                    await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Could not send the ticket panel or save configuration. Check the bot\'s permissions.' }).catch((err) => {
                        logger.error('Failed to send error reply', {
                            error: err.message,
                            guildId: interaction.guildId
                        });
                    });
                } else {
                    await handleInteractionError(interaction, error, {
                        commandName: 'ticket_setup',
                        source: 'ticket_setup_command'
                    });
                }
            }
        }
    }
};
