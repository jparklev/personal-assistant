import type { Client, ChatInputCommandInteraction, Message } from 'discord.js';
import { Events } from 'discord.js';
import { existsSync } from 'fs';
import type { DiscordTransport } from './transport';
import type { AppConfig } from '../config';
import type { StateStore } from '../state';
import { invokeClaudeCode, buildAssistantContext } from '../assistant/invoke';
import { getClaudeSession, type StreamUpdate } from '../assistant/session';
import { getFileBlipStore } from '../blips/file-store';
import type { BlipCategory } from '../blips/types';
import { extractUrls, detectContentType, CAPTURES_DIR } from '../captures';
import { VaultWatcher } from '../vault/watcher';
import { getLastVaultSync, updateVaultSync, getDueQuestions, markQuestionAsked } from '../memory';

export interface AppContext {
  cfg: AppConfig;
  state: StateStore;
  transport: DiscordTransport;
}

export function registerEventHandlers(client: Client, ctx: AppContext) {
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    await handleSlashCommand(interaction, ctx);
  });

  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    if (!message.guild) return;

    const assistantChannels = ctx.state.snapshot.assistant.channels;

    // Captures channel - special handling for URLs
    if (message.channelId === assistantChannels.captures && ctx.state.isAssistantEnabled()) {
      await handleCaptureMessage(message, ctx);
      return;
    }

    // Other assistant channels
    const isAssistantChannel =
      message.channelId === assistantChannels.morningCheckin ||
      message.channelId === assistantChannels.questions ||
      message.channelId === assistantChannels.blips;

    if (isAssistantChannel && ctx.state.isAssistantEnabled()) {
      await handleAssistantMessage(message, ctx);
      return;
    }
  });
}

async function handleSlashCommand(interaction: ChatInputCommandInteraction, ctx: AppContext) {
  const { commandName } = interaction;
  const guildId = interaction.guildId;

  if (!guildId) {
    await interaction.reply({ content: 'This command must be used in a server.', ephemeral: true });
    return;
  }

  try {
    switch (commandName) {
      case 'blip':
        await handleBlip(interaction, ctx);
        break;
      case 'assistant':
        await handleAssistant(interaction, ctx);
        break;
      case 'help':
        await handleHelp(interaction);
        break;
      default:
        await interaction.reply({ content: `Unknown command: /${commandName}`, ephemeral: true });
    }
  } catch (e: any) {
    const errorMsg = e?.message || String(e);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: `Error: ${errorMsg}` });
    } else {
      await interaction.reply({ content: `Error: ${errorMsg}`, ephemeral: true });
    }
  }
}

async function handleHelp(interaction: ChatInputCommandInteraction) {
  const help = [
    '**Personal Assistant**',
    '',
    '**Blips** (small ideas to incubate)',
    '• `/blip capture <content>` - Capture a new blip',
    '• `/blip list` - Show recent blips',
    '• `/blip surface` - Get blips ready for review',
    '• `/blip note <id> <note>` - Add a note',
    '• `/blip snooze <id>` - Hide for a while',
    '• `/blip archive <id>` - Archive a blip',
    '',
    '**Captures** (post a URL in the captures channel)',
    '• YouTube videos, podcasts, articles, PDFs',
    '',
    '**Settings**',
    '• `/assistant enable` - Enable/disable assistant',
    '• `/assistant channel` - Set channels',
    '• `/assistant status` - Show configuration',
    '• `/assistant sync` - Sync with vault',
  ].join('\n');

  await interaction.reply(help);
}

// ============== Assistant Message Handler ==============

async function handleAssistantMessage(message: Message, ctx: AppContext): Promise<void> {
  const text = message.content.trim();
  if (!text) return;

  const assistantChannels = ctx.state.snapshot.assistant.channels;
  let channelType = 'general';
  if (message.channelId === assistantChannels.morningCheckin) channelType = 'morning-checkin';
  else if (message.channelId === assistantChannels.questions) channelType = 'questions';
  else if (message.channelId === assistantChannels.blips) channelType = 'blips';

  // Send initial progress message
  const progressMsg = await message.reply('🧠 Thinking...');
  let lastUpdateTime = Date.now();
  let lastStatus = '';

  const prompt = `You are the personal assistant responding in the ${channelType} Discord channel.

${buildAssistantContext()}

## User Message

${text}

## Instructions

Respond as a thoughtful personal assistant. Remember:
- Encourage thinking, don't just give answers
- Ask clarifying questions
- Be concise and direct
- No emojis unless the user uses them
- If this is about a blip, help develop the idea
- If this is a response to a question, acknowledge and follow up

If the user shares something you should remember, note it. If they correct you, acknowledge it.

Output ONLY your response message, nothing else.`;

  try {
    const session = getClaudeSession();

    const result = await session.sendWithStreaming(prompt, async (update: StreamUpdate) => {
      // Throttle updates to avoid rate limiting (max every 2 seconds)
      const now = Date.now();
      if (now - lastUpdateTime < 2000 && !update.isComplete) return;

      let statusLine = '';
      if (update.type === 'thinking') {
        statusLine = '🧠 Thinking...';
      } else if (update.type === 'tool') {
        statusLine = `⚙️ ${update.content.slice(0, 80)}`;
      } else if (update.type === 'response' && !update.isComplete) {
        statusLine = '📝 Writing...';
      }

      // Only update if status changed
      if (statusLine && statusLine !== lastStatus) {
        lastStatus = statusLine;
        lastUpdateTime = now;
        try {
          await progressMsg.edit(statusLine);
        } catch {
          // Message may have been deleted
        }
      }
    });

    // Final response
    if (result.text) {
      const maxLen = 1900;
      const responseText = result.text.slice(0, maxLen);
      await progressMsg.edit(responseText);

      // If response is longer, send additional messages
      if (result.text.length > maxLen) {
        let remaining = result.text.slice(maxLen);
        while (remaining.length > 0) {
          const chunk = remaining.slice(0, maxLen);
          await message.reply(chunk);
          remaining = remaining.slice(maxLen);
        }
      }
    } else {
      await progressMsg.edit('I had trouble processing that. Please try again.');
    }
  } catch (error: any) {
    await progressMsg.edit(`I had trouble processing that. ${error?.message || 'Please try again.'}`);
  }
}

// ============== Capture Handler ==============

async function handleCaptureMessage(message: Message, ctx: AppContext): Promise<void> {
  const text = message.content.trim();
  if (!text) return;

  const urls = extractUrls(text);

  if (urls.length === 0) {
    await message.reply('No URLs found. Post a link to capture its content.');
    return;
  }

  for (const url of urls) {
    const contentType = detectContentType(url);

    // Send initial progress message
    const progressMsg = await message.reply(`⏳ Capturing ${contentType}...`);
    let lastUpdateTime = Date.now();
    let lastStatus = '';

    const extractionInstructions = getExtractionInstructions(url, contentType);

    const prompt = `You are the personal assistant. Capture and save content from this URL.

${buildAssistantContext()}

## URL to Capture

${url}

## Content Type

Detected as: ${contentType}

${extractionInstructions}

## Save Instructions

Save the file to: ${CAPTURES_DIR}/

Use this format:
- Filename: YYYY-MM-DD-title-slug.md (max 60 chars for slug)
- Include YAML frontmatter:
  \`\`\`yaml
  ---
  title: "The Title"
  url: "${url}"
  type: ${contentType}
  captured: YYYY-MM-DD
  tags: [topic1, topic2]
  description: "Brief 1-2 sentence description"
  ---
  \`\`\`
- Include the full extracted content after the frontmatter

After saving, respond with a brief confirmation including the filename and a 1-line summary.`;

    try {
      const session = getClaudeSession();

      const result = await session.sendWithStreaming(prompt, async (update: StreamUpdate) => {
        // Throttle updates to avoid rate limiting (max every 2 seconds)
        const now = Date.now();
        if (now - lastUpdateTime < 2000 && !update.isComplete) return;

        let statusLine = '';
        if (update.type === 'thinking') {
          statusLine = `🧠 Thinking...`;
        } else if (update.type === 'tool') {
          statusLine = `⚙️ ${update.content.slice(0, 100)}`;
        } else if (update.type === 'response' && !update.isComplete) {
          statusLine = `📝 Writing response...`;
        }

        // Only update if status changed
        if (statusLine && statusLine !== lastStatus) {
          lastStatus = statusLine;
          lastUpdateTime = now;
          try {
            await progressMsg.edit(`⏳ Capturing ${contentType}...\n${statusLine}`);
          } catch {
            // Message may have been deleted
          }
        }
      });

      // Final response
      if (result.text) {
        const toolsSummary = result.toolCalls.length > 0
          ? `\n\n_Tools: ${result.toolCalls.join(', ')} | ${(result.durationMs / 1000).toFixed(1)}s_`
          : `\n\n_${(result.durationMs / 1000).toFixed(1)}s_`;

        const finalText = result.text.slice(0, 1800) + toolsSummary;
        await progressMsg.edit(finalText);
      } else {
        await progressMsg.edit(`❌ Failed to capture ${url}: No response`);
      }
    } catch (error: any) {
      await progressMsg.edit(`❌ Failed to capture ${url}: ${error?.message || 'Unknown error'}`);
    }
  }
}

function getExtractionInstructions(url: string, contentType: string): string {
  if (contentType === 'youtube') {
    return `## YouTube Video Extraction

This is a YouTube video.

### Step 1: Try yt-dlp for subtitles first (fastest)
\`\`\`bash
cd /tmp && yt-dlp --write-auto-sub --skip-download --sub-lang en -o "yt_capture" "${url}" 2>&1
\`\`\`

If subtitles exist, read and clean the VTT file:
- File at /tmp/yt_capture.en.vtt
- Remove timestamps and formatting tags, keep just the text
- Remove duplicate lines

### Step 2: If no subtitles, transcribe with mlx-whisper
\`\`\`bash
yt-dlp -x --audio-format mp3 -o "/tmp/yt_capture.%(ext)s" "${url}"
mlx_whisper /tmp/yt_capture.mp3 --model mlx-community/whisper-turbo -f txt -o /tmp
cat /tmp/yt_capture.txt
rm /tmp/yt_capture.mp3
\`\`\`

### Step 3: Get video metadata
\`\`\`bash
yt-dlp --dump-json --skip-download "${url}" 2>/dev/null | head -c 5000
\`\`\`

### Step 4: Clean up all temp files
\`\`\`bash
rm -f /tmp/yt_capture.*
\`\`\`

Extract: title, channel name, description, duration, and full transcript.`;
  }

  if (contentType === 'podcast') {
    const isPocketCasts = url.includes('pocketcasts.com') || url.includes('pca.st');
    return `## Podcast Extraction

This is a podcast episode.

### Step 1: Fetch Page Metadata
Fetch the page with WebFetch to get episode metadata.
${isPocketCasts ? '- Note: pca.st links redirect to pocketcasts.com - follow the redirect' : ''}

### Step 2: Extract Episode Info
Look for and capture:
- Episode title
- Show/podcast name
- Episode description/show notes
- Guest names if mentioned
- Duration
- Release date
- Links mentioned in show notes

### Step 3: Transcribe with mlx-whisper
\`\`\`bash
curl -L -o /tmp/podcast_capture.mp3 "AUDIO_URL"
mlx_whisper /tmp/podcast_capture.mp3 --model mlx-community/whisper-turbo -f txt -o /tmp
cat /tmp/podcast_capture.txt
rm /tmp/podcast_capture.mp3
\`\`\``;
  }

  if (contentType === 'pdf') {
    return `## PDF Extraction

This is a PDF file. To extract:

1. Download the PDF:
   \`\`\`bash
   curl -L -o /tmp/capture.pdf "${url}"
   \`\`\`

2. Try to extract text:
   \`\`\`bash
   pdftotext /tmp/capture.pdf /tmp/capture.txt 2>/dev/null && cat /tmp/capture.txt
   \`\`\`

3. Clean up temp files when done.`;
  }

  return `## Article/Webpage Extraction

This is a webpage. Use WebFetch to get the page content and extract the main article text.`;
}

// ============== Blip Handlers ==============

async function handleBlip(interaction: ChatInputCommandInteraction, ctx: AppContext) {
  const subcommand = interaction.options.getSubcommand();
  const blipStore = getFileBlipStore();

  switch (subcommand) {
    case 'capture': {
      const content = interaction.options.getString('content', true);
      const category = interaction.options.getString('category') as BlipCategory | null;

      const blip = blipStore.capture(
        content,
        {
          type: 'discord',
          channelId: interaction.channelId,
          messageId: interaction.id,
          userId: interaction.user.id,
        },
        category || undefined
      );

      await interaction.reply({
        content: `Captured blip \`${blip.id}\`${category ? ` (${category})` : ''}\n> ${content.slice(0, 100)}${content.length > 100 ? '...' : ''}`,
        ephemeral: false,
      });
      break;
    }

    case 'list': {
      const recent = blipStore.getRecent(10);
      if (recent.length === 0) {
        await interaction.reply({ content: 'No blips yet. Capture one with `/blip capture`!', ephemeral: true });
        return;
      }

      const lines = recent.map((b) => {
        const preview = b.content.slice(0, 60).replace(/\n/g, ' ');
        const state = b.state === 'captured' ? '🆕' : b.state === 'active' ? '🔥' : b.state === 'incubating' ? '💤' : '📦';
        return `${state} \`${b.id}\` ${preview}${b.content.length > 60 ? '...' : ''}`;
      });

      await interaction.reply({
        content: `**Recent Blips**\n${lines.join('\n')}`,
        ephemeral: false,
      });
      break;
    }

    case 'surface': {
      const count = interaction.options.getInteger('count') || 3;
      const results = blipStore.getSurfaceableBlips(count);

      if (results.length === 0) {
        await interaction.reply({ content: 'No blips ready to surface right now.', ephemeral: true });
        return;
      }

      const lines = results.map((r, i) => {
        blipStore.markSurfaced(r.blip.id);
        const preview = r.blip.content.slice(0, 80).replace(/\n/g, ' ');
        return `**${i + 1}.** \`${r.blip.id}\` — ${r.reason}\n> ${preview}${r.blip.content.length > 80 ? '...' : ''}\nMoves: ${r.suggestedMoves.join(', ')}`;
      });

      await interaction.reply({
        content: `**Blips to Consider**\n\n${lines.join('\n\n')}`,
        ephemeral: false,
      });
      break;
    }

    case 'note': {
      const id = interaction.options.getString('id', true);
      const note = interaction.options.getString('note', true);

      if (blipStore.addNote(id, note)) {
        await interaction.reply({ content: `📝 Added note to blip \`${id}\``, ephemeral: false });
      } else {
        await interaction.reply({ content: `Blip \`${id}\` not found.`, ephemeral: true });
      }
      break;
    }

    case 'snooze': {
      const id = interaction.options.getString('id', true);
      const days = interaction.options.getInteger('days') || 7;

      if (blipStore.snooze(id, days)) {
        await interaction.reply({ content: `💤 Snoozed blip \`${id}\` for ${days} days`, ephemeral: false });
      } else {
        await interaction.reply({ content: `Blip \`${id}\` not found.`, ephemeral: true });
      }
      break;
    }

    case 'archive': {
      const id = interaction.options.getString('id', true);

      if (blipStore.archive(id)) {
        await interaction.reply({ content: `📦 Archived blip \`${id}\``, ephemeral: false });
      } else {
        await interaction.reply({ content: `Blip \`${id}\` not found.`, ephemeral: true });
      }
      break;
    }

    case 'stats': {
      const stats = blipStore.getStats();
      const stateLines = Object.entries(stats.byState)
        .map(([state, count]) => `  ${state}: ${count}`)
        .join('\n');
      const catLines = Object.entries(stats.byCategory)
        .map(([cat, count]) => `  ${cat}: ${count}`)
        .join('\n');

      await interaction.reply({
        content: `**Blip Statistics**\nTotal: ${stats.total}\n\n**By State:**\n${stateLines}\n\n**By Category:**\n${catLines}`,
        ephemeral: false,
      });
      break;
    }

    case 'process': {
      await interaction.deferReply();

      const result = await invokeClaudeCode({
        prompt: `You are the personal assistant. Review the Obsidian vault for new items to capture as blips.

${buildAssistantContext()}

## Your Task

1. Read the Note Inbox.md file and identify any new items worth capturing
2. Check the Clippings/ folder for new highlights
3. For each item worth capturing, describe what it is

For now, just report what you find. Output a brief summary.`,
        timeout: 60000,
      });

      await interaction.editReply({
        content: result.success
          ? `**Vault Review**\n${result.text}`
          : `**Review failed:** ${result.error}`,
      });
      break;
    }

    default:
      await interaction.reply({ content: `Unknown subcommand: ${subcommand}`, ephemeral: true });
  }
}

// ============== Assistant Handlers ==============

async function handleAssistant(interaction: ChatInputCommandInteraction, ctx: AppContext) {
  const subcommand = interaction.options.getSubcommand();

  switch (subcommand) {
    case 'enable': {
      const enabled = interaction.options.getBoolean('enabled', true);

      await ctx.state.transact(async () => {
        ctx.state.setAssistantEnabled(enabled);
      });

      await interaction.reply({
        content: enabled ? '✅ Assistant enabled' : '⏸️ Assistant disabled',
        ephemeral: false,
      });
      break;
    }

    case 'channel': {
      const type = interaction.options.getString('type', true) as 'morningCheckin' | 'questions' | 'blips' | 'captures';
      const channel = interaction.options.getChannel('channel', true);

      await ctx.state.transact(async () => {
        ctx.state.setAssistantChannel(type, channel.id);
      });

      const typeNames = {
        morningCheckin: 'Morning Check-in',
        questions: 'Questions',
        blips: 'Blips',
        captures: 'Captures',
      };

      await interaction.reply({
        content: `Set ${typeNames[type]} channel to <#${channel.id}>`,
        ephemeral: false,
      });
      break;
    }

    case 'status': {
      const enabled = ctx.state.isAssistantEnabled();
      const channels = ctx.state.snapshot.assistant.channels;
      const blipStore = getFileBlipStore();
      const vaultSync = getLastVaultSync();

      const channelLines = [
        channels.morningCheckin ? `  Morning: <#${channels.morningCheckin}>` : '  Morning: not set',
        channels.questions ? `  Questions: <#${channels.questions}>` : '  Questions: not set',
        channels.blips ? `  Blips: <#${channels.blips}>` : '  Blips: not set',
        channels.captures ? `  Captures: <#${channels.captures}>` : '  Captures: not set',
      ].join('\n');

      const vaultPath = ctx.cfg.vaultPath;
      const vaultExists = existsSync(vaultPath);

      await interaction.reply({
        content: `**Assistant Status**
Enabled: ${enabled ? '✅' : '❌'}

**Channels:**
${channelLines}

**Vault:**
  Path: \`${vaultPath}\`
  Accessible: ${vaultExists ? '✅' : '❌'}
  Last sync: ${vaultSync.at || 'never'}

**Blips:**
  Total: ${blipStore.all.length}`,
        ephemeral: false,
      });
      break;
    }

    case 'sync': {
      await interaction.deferReply();

      const vaultPath = ctx.cfg.vaultPath;
      const vaultWatcher = new VaultWatcher(vaultPath);

      if (!existsSync(vaultPath)) {
        await interaction.editReply({ content: `❌ Vault not found at \`${vaultPath}\`` });
        return;
      }

      const currentCommit = vaultWatcher.getCurrentCommit();
      const lastSync = getLastVaultSync();

      let changes: { type: string; path: string }[] = [];
      if (lastSync.hash && currentCommit) {
        changes = vaultWatcher.getChangesSince(lastSync.hash);
      }

      if (currentCommit) {
        updateVaultSync(currentCommit);
      }

      const changesSummary = changes.length > 0
        ? changes.slice(0, 5).map((c) => `  ${c.type}: ${c.path}`).join('\n') +
          (changes.length > 5 ? `\n  ...and ${changes.length - 5} more` : '')
        : '  (no changes)';

      await interaction.editReply({
        content: `**Vault Sync Complete**

📁 **Files changed since last sync:** ${changes.length}
${changesSummary}

🔖 **Commit:** \`${currentCommit?.slice(0, 7) || 'none'}\``,
      });
      break;
    }

    default:
      await interaction.reply({ content: `Unknown subcommand: ${subcommand}`, ephemeral: true });
  }
}
