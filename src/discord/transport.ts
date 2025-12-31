import type {
  Client,
  TextChannel,
  ForumChannel,
  ThreadChannel,
  Message,
  MessageCreateOptions,
  ChatInputCommandInteraction,
  Guild,
} from 'discord.js';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import type { ReacordDiscordJs } from 'reacord';
import type { ReactNode } from 'react';

const FORUM_CHANNEL_NAME = 'agent-threads';

export interface DiscordTransport {
  sendMessage: (
    channelId: string,
    text: string,
    opts?: { threadId?: string; silent?: boolean }
  ) => Promise<string>;

  editMessage: (
    channelId: string,
    messageId: string,
    text: string,
    opts?: { threadId?: string }
  ) => Promise<void>;

  deleteMessage: (channelId: string, messageId: string, opts?: { threadId?: string }) => Promise<void>;

  sendFile: (
    channelId: string,
    filename: string,
    content: string,
    opts?: { threadId?: string }
  ) => Promise<void>;

  sendTyping: (channelId: string, opts?: { threadId?: string }) => Promise<void>;

  createForumPost: (forumChannelId: string, title: string, content: string) => Promise<string>;

  archiveForumPost: (threadId: string) => Promise<void>;

  deleteForumPost: (threadId: string) => Promise<void>;

  replyToInteraction: (
    interaction: ChatInputCommandInteraction,
    content: string | { embeds?: any[]; content?: string }
  ) => Promise<void>;

  deferReply: (interaction: ChatInputCommandInteraction, ephemeral?: boolean) => Promise<void>;

  editReply: (
    interaction: ChatInputCommandInteraction,
    content: string | { embeds?: any[]; content?: string }
  ) => Promise<void>;

  reacord: ReacordDiscordJs;
  client: Client;
}

/**
 * Find or create the forum channel for agent threads.
 * Returns the forum channel ID.
 */
export async function ensureForumChannel(client: Client, guildId?: string): Promise<string> {
  // If guildId provided, use that guild. Otherwise use first available guild.
  let guild: Guild | undefined;

  if (guildId) {
    guild = await client.guilds.fetch(guildId);
  } else {
    const guilds = await client.guilds.fetch();
    const firstGuildId = guilds.first()?.id;
    if (firstGuildId) {
      guild = await client.guilds.fetch(firstGuildId);
    }
  }

  if (!guild) {
    throw new Error('No guild available. Invite the bot to a server first.');
  }

  // Look for existing forum channel
  const channels = await guild.channels.fetch();
  const existing = channels.find(
    (ch) => ch?.type === ChannelType.GuildForum && ch.name === FORUM_CHANNEL_NAME
  );

  if (existing) {
    console.log(`  Found existing forum channel: #${FORUM_CHANNEL_NAME} (${existing.id})`);
    return existing.id;
  }

  // Create new forum channel
  console.log(`  Creating forum channel: #${FORUM_CHANNEL_NAME}`);
  const forum = await guild.channels.create({
    name: FORUM_CHANNEL_NAME,
    type: ChannelType.GuildForum,
    topic: 'Each agent gets its own thread here',
    reason: 'Agent orchestrator auto-setup',
  });

  console.log(`  Created forum channel: #${FORUM_CHANNEL_NAME} (${forum.id})`);
  return forum.id;
}

function chunkText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= max) {
      chunks.push(remaining);
      break;
    }
    let cut = remaining.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = max;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n/, '');
  }
  return chunks;
}

export function createDiscordTransport(client: Client, reacord: ReacordDiscordJs): DiscordTransport {
  async function getTextChannel(channelId: string): Promise<TextChannel | ThreadChannel> {
    const channel = await client.channels.fetch(channelId);
    if (!channel) throw new Error(`Channel ${channelId} not found`);
    if (!channel.isTextBased()) throw new Error(`Channel ${channelId} is not text-based`);
    return channel as TextChannel | ThreadChannel;
  }

  return {
    async sendMessage(channelId, text, opts) {
      const targetId = opts?.threadId ?? channelId;
      const channel = await getTextChannel(targetId);

      const chunks = chunkText(text, 1900);
      let lastMsgId = '';

      for (const chunk of chunks) {
        const msgOpts: MessageCreateOptions = { content: chunk };
        if (opts?.silent) {
          msgOpts.flags = ['SuppressNotifications'];
        }
        const msg = await channel.send(msgOpts);
        lastMsgId = msg.id;
      }

      return lastMsgId;
    },

    async editMessage(channelId, messageId, text, opts) {
      const targetId = opts?.threadId ?? channelId;
      const channel = await getTextChannel(targetId);
      const msg = await channel.messages.fetch(messageId);
      await msg.edit(text.slice(0, 1900));
    },

    async deleteMessage(channelId, messageId, opts) {
      const targetId = opts?.threadId ?? channelId;
      const channel = await getTextChannel(targetId);
      const msg = await channel.messages.fetch(messageId);
      await msg.delete();
    },

    async sendFile(channelId, filename, content, opts) {
      const targetId = opts?.threadId ?? channelId;
      const channel = await getTextChannel(targetId);
      await channel.send({
        files: [{ attachment: Buffer.from(content, 'utf-8'), name: filename }],
      });
    },

    async sendTyping(channelId, opts) {
      const targetId = opts?.threadId ?? channelId;
      const channel = await getTextChannel(targetId);
      await channel.sendTyping();
    },

    async createForumPost(forumChannelId, title, content) {
      const channel = await client.channels.fetch(forumChannelId);
      if (!channel) throw new Error(`Forum channel ${forumChannelId} not found`);
      if (channel.type !== ChannelType.GuildForum) {
        throw new Error(`Channel ${forumChannelId} is not a forum channel`);
      }

      const forum = channel as ForumChannel;
      const thread = await forum.threads.create({
        name: title.slice(0, 100),
        message: { content: content.slice(0, 1900) },
      });

      return thread.id;
    },

    async archiveForumPost(threadId) {
      const channel = await client.channels.fetch(threadId);
      if (!channel) return;
      if (channel.isThread()) {
        await (channel as ThreadChannel).setArchived(true);
      }
    },

    async deleteForumPost(threadId) {
      const channel = await client.channels.fetch(threadId);
      if (!channel) return;
      if (channel.isThread()) {
        await (channel as ThreadChannel).delete();
      }
    },

    async replyToInteraction(interaction, content) {
      if (typeof content === 'string') {
        await interaction.reply({ content: content.slice(0, 1900) });
      } else {
        await interaction.reply(content as any);
      }
    },

    async deferReply(interaction, ephemeral = false) {
      await interaction.deferReply({ ephemeral });
    },

    async editReply(interaction, content) {
      if (typeof content === 'string') {
        await interaction.editReply({ content: content.slice(0, 1900) });
      } else {
        await interaction.editReply(content as any);
      }
    },

    reacord,
    client,
  };
}
