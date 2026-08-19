// ticketButtons.js

import { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, AttachmentBuilder, MessageFlags } from 'discord.js';
import { createEmbed, successEmbed } from '../utils/embeds.js';
import { createTicket, closeTicket, claimTicket, updateTicketPriority } from '../services/ticket.js';
import { getGuildConfig } from '../services/config/guildConfig.js';
import { logTicketEvent } from '../utils/ticket/ticketLogging.js';
import { logger } from '../utils/logger.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import { checkRateLimit } from '../utils/rateLimiter.js';
import { replyUserError, ErrorTypes, handleInteractionError, createError } from '../utils/errorHandler.js';
import { getTicketPermissionContext } from '../utils/ticket/ticketPermissions.js';

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function ensureGuildContext(interaction) {
  if (interaction.inGuild()) {
    return true;
  }

  if (!interaction.replied && !interaction.deferred) {
    await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'This action can only be used in a server.' });
  }

  return false;
}

async function assertTicketPermission(interaction, client, actionLabel, options = {}, timeoutMs = 2500) {
  const { allowTicketCreator = false } = options;

  let context;
  try {
    const contextPromise = getTicketPermissionContext({ client, interaction });
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Timeout')), timeoutMs)
    );
    context = await Promise.race([contextPromise, timeoutPromise]);
  } catch (error) {
    if (error.message === 'Timeout') {
      throw createError(
        'Ticket permission timeout',
        ErrorTypes.RATE_LIMIT,
        'The permission check took too long. Please try again.'
      );
    }
    throw createError(
      'Ticket permission check failed',
      ErrorTypes.UNKNOWN,
      `Failed to check permissions: ${error.message}`
    );
  }

  if (!context.ticketData) {
    throw createError(
      'Not a ticket channel',
      ErrorTypes.VALIDATION,
      'This action can only be used in a valid ticket channel.'
    );
  }

  const allowed = allowTicketCreator ? context.canCloseTicket : context.canManageTicket;
  if (!allowed) {
    const permissionMessage = allowTicketCreator
      ? 'You must have **Manage Channels**, the configured **Ticket Staff Role**, or be the **ticket creator**.'
      : 'You must have **Manage Channels** or the configured **Ticket Staff Role**.';
    throw createError(
      'Ticket permission denied',
      ErrorTypes.PERMISSION,
      `${permissionMessage}\n\nYou cannot ${actionLabel}.`
    );
  }

  return context;
}

async function ensureTicketPermission(interaction, client, actionLabel, options = {}) {
  const { allowTicketCreator = false } = options;

  const context = await getTicketPermissionContext({ client, interaction });

  if (!context.ticketData) {
    await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'This action can only be used in a valid ticket channel.' });
    return null;
  }

  const allowed = allowTicketCreator ? context.canCloseTicket : context.canManageTicket;
  if (!allowed) {
    const permissionMessage = allowTicketCreator
      ? 'You must have **Manage Channels**, the configured **Ticket Staff Role**, or be the **ticket creator**.'
      : 'You must have **Manage Channels** or the configured **Ticket Staff Role**.';

    await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: `${permissionMessage}\n\nYou cannot ${actionLabel}.` });
    return null;
  }

  return context;
}

const createTicketHandler = {
  name: 'create_ticket',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      const rateLimitKey = `${interaction.user.id}:create_ticket`;
      const allowed = await checkRateLimit(rateLimitKey, 3, 60000);
      if (!allowed) {
        await replyUserError(interaction, { type: ErrorTypes.RATE_LIMIT, message: 'You are creating tickets too quickly. Please wait a minute and try again.' });
        return;
      }

      const config = await getGuildConfig(client, interaction.guildId);
      const maxTicketsPerUser = config.maxTicketsPerUser || 3;
      
      const { getUserTicketCount } = await import('../services/ticket.js');
      const currentTicketCount = await getUserTicketCount(interaction.guildId, interaction.user.id);
      
      if (currentTicketCount >= maxTicketsPerUser) {
        return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: `You have reached the maximum number of open tickets (${maxTicketsPerUser}).\n\nPlease close your existing tickets before opening a new one.` });
      }
      
      const modal = new ModalBuilder()
        .setCustomId('create_ticket_modal')
        .setTitle('Create a Ticket');

      const reasonInput = new TextInputBuilder()
        .setCustomId('reason')
        .setLabel('Why are you creating this ticket?')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Describe your issue...')
        .setRequired(true)
        .setMaxLength(1000);

      const actionRow = new ActionRowBuilder().addComponents(reasonInput);
      modal.addComponents(actionRow);

      await interaction.showModal(modal);
    } catch (error) {
      logger.error('Error creating ticket modal:', error);
      if (!interaction.replied && !interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Could not open ticket creation form.' });
      }
    }
  }
};

// Handler for multiple ticket type buttons (create_ticket_type:0, create_ticket_type:1, etc.)
const createTicketTypeHandler = {
  name: 'create_ticket_type',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      const rateLimitKey = `${interaction.user.id}:create_ticket`;
      const allowed = await checkRateLimit(rateLimitKey, 3, 60000);
      if (!allowed) {
        await replyUserError(interaction, { type: ErrorTypes.RATE_LIMIT, message: 'You are creating tickets too quickly. Please wait a minute and try again.' });
        return;
      }

      const config = await getGuildConfig(client, interaction.guildId);
      const maxTicketsPerUser = config.maxTicketsPerUser || 3;
      
      const { getUserTicketCount } = await import('../services/ticket.js');
      const currentTicketCount = await getUserTicketCount(interaction.guildId, interaction.user.id);
      
      if (currentTicketCount >= maxTicketsPerUser) {
        return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: `You have reached the maximum number of open tickets (${maxTicketsPerUser}).\n\nPlease close your existing tickets before opening a new one.` });
      }
      
      // Extract the ticket type index from custom ID (e.g., "create_ticket_type:0")
      const customIdParts = interaction.customId.split(':');
      const typeIndex = parseInt(customIdParts[1], 10);
      const ticketType = config.ticketButtonLabels?.[typeIndex] || `Ticket Type ${typeIndex + 1}`;
      
      const modal = new ModalBuilder()
        .setCustomId(`create_ticket_modal:${typeIndex}`)
        .setTitle(`Create a ${ticketType}`);

      const reasonInput = new TextInputBuilder()
        .setCustomId('reason')
        .setLabel(`Why are you creating a ${ticketType}?`)
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Describe your issue...')
        .setRequired(true)
        .setMaxLength(1000);

      const actionRow = new ActionRowBuilder().addComponents(reasonInput);
      modal.addComponents(actionRow);

      await interaction.showModal(modal);
    } catch (error) {
      logger.error('Error creating ticket type modal:', error);
      if (!interaction.replied && !interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Could not open ticket creation form.' });
      }
    }
  }
};

const createTicketModalHandler = {
  name: 'create_ticket_modal',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;
      
      const reason = interaction.fields.getTextInputValue('reason');
      const config = await getGuildConfig(client, interaction.guildId);
      const categoryId = config.ticketCategoryId || null;
      
      // Extract ticket type from custom ID if it's a typed ticket (e.g., "create_ticket_modal:0")
      const customIdParts = interaction.customId.split(':');
      const typeIndex = customIdParts[1] ? parseInt(customIdParts[1], 10) : null;
      const ticketType = typeIndex !== null ? config.ticketButtonLabels?.[typeIndex] || `Ticket Type ${typeIndex + 1}` : null;
      
      const { channel } = await createTicket(
        interaction.guild,
        interaction.member,
        categoryId,
        reason,
        ticketType
      );
      await interaction.editReply({
        embeds: [successEmbed(
          'Ticket Created',
          `Your ticket has been created in ${channel}!`
        )]
      });
    } catch (error) {
      await handleInteractionError(interaction, error, { type: 'button', handler: 'ticket', customId: interaction.customId });
    }
  }
};

// ... keep other handlers unchanged ...

const priorityTicketHandler = {
  name: 'ticket_priority',
  async execute(interaction, client, args) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      await assertTicketPermission(interaction, client, 'change ticket priority', {}, 2000);

      // If a priority argument was passed (backwards compatibility), use it directly
      const argPriority = args?.[0];
      if (argPriority) {
        await updateTicketPriority(interaction.channel, argPriority, interaction.user);
        await interaction.deferUpdate().catch(() => {});
        if (!interaction.replied && !interaction.deferred) {
          await InteractionHelper.safeEditReply(interaction, { embeds: [successEmbed('Priority Updated', `Ticket priority set to **${argPriority.toUpperCase()}**.`)] }).catch(()=>{});
        }
        return;
      }

      // No arg provided -> show an ephemeral select menu to choose priority
      await interaction.deferReply({ ephemeral: true }).catch(() => {});
      const { ActionRowBuilder, StringSelectMenuBuilder } = await import('discord.js');

      const select = new StringSelectMenuBuilder()
        .setCustomId(`ticket_priority_select:${interaction.id}`)
        .setPlaceholder('Select priority...')
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(
          { label: 'Low', value: 'low', description: 'Low priority', emoji: '🟢' },
          { label: 'Medium', value: 'medium', description: 'Medium priority', emoji: '🟡' },
          { label: 'High', value: 'high', description: 'High priority', emoji: '🔴' },
          { label: 'Urgent', value: 'urgent', description: 'Urgent priority', emoji: '🚨' },
          { label: 'None', value: 'none', description: 'Remove priority', emoji: '⚪' },
        );

      const row = new ActionRowBuilder().addComponents(select);

      await interaction.editReply({ content: 'Choose a priority for this ticket:', components: [row] }).catch(()=>{});

      // Wait for the select menu submission from the same user
      const filter = i => i.user.id === interaction.user.id && i.customId && i.customId.startsWith('ticket_priority_select:');
      const selected = await interaction.channel.awaitMessageComponent({ filter, time: 60_000 }).catch(() => null);

      if (!selected) {
        return interaction.editReply({ content: 'No selection made. Priority not changed.', components: [] }).catch(()=>{});
      }

      const chosen = selected.values[0];
      await selected.deferUpdate().catch(() => {});

      await updateTicketPriority(interaction.channel, chosen, interaction.user);

      await interaction.editReply({ content: `Priority updated to **${chosen.toUpperCase()}**.`, components: [] }).catch(()=>{});
    } catch (error) {
      logger.error('Error updating ticket priority:', error);
      if (!interaction.replied && !interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while updating the priority.' }).catch(()=>{});
      } else if (interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while updating the priority.' }).catch(()=>{});
      }
    }
  }
};

export default createTicketHandler;
export { 
  createTicketModalHandler,
  createTicketTypeHandler,
  priorityTicketHandler,
};
