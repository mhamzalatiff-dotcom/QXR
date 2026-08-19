// services/ticket.js — update: replace small priority buttons with single Priority button and add improved updateTicketPriority

import { ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, AttachmentBuilder } from 'discord.js';
import { buildStandardLogEmbed, formatLogLine } from '../utils/logging/logEmbeds.js';
import { getGuildConfig } from './config/guildConfig.js';
import { getTicketData, saveTicketData, deleteTicketData, getOpenTicketCountForUser, incrementTicketCounter } from '../utils/database.js';
import { logger } from '../utils/logger.js';
import { createEmbed, errorEmbed } from '../utils/embeds.js';
import { logTicketEvent } from '../utils/ticket/ticketLogging.js';
import { createError, ErrorTypes } from '../utils/errorHandler.js';
import { ensureTypedServiceError, wrapServiceBoundary } from '../utils/serviceErrorBoundary.js';
import { PRIORITY_MAP } from '../utils/helpers.js';
const TICKET_DELETE_DELAY_MS = 3000;
const TICKET_DELETE_DELAY_SECONDS = Math.floor(TICKET_DELETE_DELAY_MS / 1000);
const TICKET_SERVICE = 'ticketService';

function ticketUserError(message, userMessage, type = ErrorTypes.VALIDATION, context = {}) {
  throw createError(message, type, userMessage, { service: TICKET_SERVICE, ...context });
}

function requireTicket(ticketData, channel) {
  if (!ticketData) {
    ticketUserError(
      'Not a ticket channel',
      'This is not a ticket channel.',
      ErrorTypes.VALIDATION,
      { channelId: channel?.id, guildId: channel?.guild?.id }
    );
  }
  return ticketData;
}

function rethrowTicketError(error, operation, userMessage, context = {}) {
  throw ensureTypedServiceError(error, {
    service: TICKET_SERVICE,
    operation,
    message: `Ticket operation failed: ${operation}`,
    userMessage,
    context,
  });
}

// ... (rest of file unchanged until createTicket) ...

// inside createTicket after const row = buildTicketControlRow(); replace the small priority buttons block with single button
if (ticketConfig.enablePriority) {
  row.addComponents(
    new ButtonBuilder()
      .setCustomId('ticket_priority')
      .setLabel('Priority')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('⚡')
  );
}

// ... (rest of createTicket) ...

// Replace updateTicketPriority function with improved behavior
export async function updateTicketPriority(channel, priority, updater) {
  try {
    const ticketData = requireTicket(await getTicketData(channel.guild.id, channel.id), channel);

    const priorityInfo = PRIORITY_MAP[priority];
    if (!priorityInfo) {
      ticketUserError(
        'Invalid priority level',
        'Invalid priority level.',
        ErrorTypes.VALIDATION,
        { channelId: channel.id, priority, operation: 'updateTicketPriority' }
      );
    }

    const previousPriority = ticketData.priority;
    ticketData.priority = priority;
    ticketData.priorityUpdatedBy = updater.id;
    ticketData.priorityUpdatedAt = new Date().toISOString();

    await saveTicketData(channel.guild.id, channel.id, ticketData);

    // Build regex to remove previously applied known priority emojis (prefixes or suffixes)
    const priorityEmojis = Object.values(PRIORITY_MAP).map(i => i.emoji).filter(Boolean);
    const escaped = priorityEmojis.map(e => e.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')).join('|');
    const emojiRegex = escaped ? new RegExp(`(?:\\s*-\\s*(?:${escaped}))|(?:${escaped})`, 'g') : null;

    let currentName = channel.name || '';
    let cleanName = currentName;

    if (emojiRegex) {
      cleanName = cleanName.replace(emojiRegex, '').trim();
    }
    cleanName = cleanName.replace(/[-\s]+$/g, '').trim(); // remove trailing hyphens/spaces

    // Append emoji with a hyphen if priority is not 'none'
    const newName = priority === 'none' ? cleanName : `${cleanName}-${priorityInfo.emoji}`;

    if (newName && newName !== currentName) {
      try {
        await channel.setName(newName);
      } catch (nameError) {
        logger.warn(`Could not update channel name for priority: ${nameError.message}`);
      }
    }

    // Move channel according to dashboard config:
    try {
      const config = await getGuildConfig(channel.client, channel.guild.id);
      const grouping = config.ticketPriorityGrouping || 'single'; // 'single' or 'per_level'
      let targetCategoryId = null;

      if (grouping === 'single') {
        // single category id preference: ticketPrioritySingleCategoryId, fallback to ticketPriorityDashboardCategoryId
        targetCategoryId = config.ticketPrioritySingleCategoryId || config.ticketPriorityDashboardCategoryId || null;
      } else if (grouping === 'per_level') {
        const perMap = config.ticketPriorityPerLevelCategoryIds || {};
        targetCategoryId = perMap[priority] || null;
      }

      if (targetCategoryId && channel.parentId !== targetCategoryId) {
        const targetCategory = channel.guild.channels.cache.get(targetCategoryId) || await channel.guild.channels.fetch(targetCategoryId).catch(()=>null);
        if (targetCategory && targetCategory.type === ChannelType.GuildCategory) {
          await channel.setParent(targetCategoryId, { lockPermissions: false }).catch(err => {
            logger.warn(`Could not move ticket ${channel.id} to priority category ${targetCategoryId}: ${err.message}`);
          });
        } else {
          logger.warn(`Configured priority category invalid for guild ${channel.guild.id}: ${targetCategoryId}`);
        }
      }
    } catch (moveErr) {
      logger.warn(`Error while attempting to move ticket for priority: ${moveErr.message}`);
    }

    // Update ticket message embed to reflect new priority
    const messages = await channel.messages.fetch();
    const ticketMessage = messages.find(m =>
      m.embeds.length > 0 &&
      m.embeds[0].title?.startsWith('Ticket #')
    );

    if (ticketMessage) {
      const embed = ticketMessage.embeds[0];
      const baseDesc = embed.description ? embed.description.split('\n**Priority:**')[0] : '';
      const updatedEmbed = createEmbed({
        title: embed.title || 'Ticket',
        description: `${baseDesc}\n**Priority:** ${priorityInfo.emoji} ${priorityInfo.label}`.trim(),
        color: priorityInfo.color,
        fields: embed.fields || [],
        footer: embed.footer
      });

      await ticketMessage.edit({ embeds: [updatedEmbed] }).catch(() => {});
    }

    // Notify in channel
    const updateEmbed = createEmbed({
      title: 'Priority Updated',
      description: `📊 Ticket priority updated to **${priorityInfo.emoji} ${priorityInfo.label}** by ${updater}`,
      color: priorityInfo.color
    });

    await channel.send({ embeds: [updateEmbed] }).catch(() => {});

    // Log event
    await logTicketEvent({
      client: channel.client,
      guildId: channel.guild.id,
      event: {
        type: 'priority',
        ticketId: channel.id,
        ticketNumber: ticketData.id,
        userId: ticketData.userId,
        executorId: updater.id,
        priority: priority,
        metadata: {
          previousPriority,
          updatedAt: ticketData.priorityUpdatedAt
        }
      }
    });

    return ticketData;
  } catch (error) {
    rethrowTicketError(error, 'updateTicketPriority', 'Failed to update ticket priority. Please try again in a moment.', { guildId: channel?.guild?.id, channelId: channel?.id, updaterId: updater?.id });
  }
}
