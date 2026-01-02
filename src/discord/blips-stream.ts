import type { ButtonInteraction, Client, Guild, Message, ModalSubmitInteraction, TextChannel } from 'discord.js';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ComponentType,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import { loadConfig } from '../config';
import { invokeClaude } from '../assistant/runner';
import {
  getBlipsToSurface,
  listBlips,
  readBlip,
  snoozeBlip,
  archiveBlip,
  touchBlip,
  appendToLog,
  bumpToProject,
  suggestMoves,
  findRelated,
} from '../blips';
import { parseFrontmatter, serializeFrontmatter } from '../utils/frontmatter';

const BLIPS_STREAM_CUSTOM_ID_PREFIX = 'blips_stream:';
const BLIPS_STREAM_MODAL_PREFIX = 'blips_stream_modal:';

type StreamState = {
  messageId?: string;
  currentFilename?: string;
  view?: 'normal' | 'related' | 'prompt';
  busy?: { kind: 'ai_related' | 'prompt' | 'ai_move'; at: string };
  prompt?: {
    questions: string[];
  };
  relatedAi?: {
    forFilename: string;
    status: 'loading' | 'done' | 'error';
    items: Array<{ filename: string; title: string }>;
    at: string;
    error?: string;
  };
};

type StreamStateFile = Record<string, StreamState>;

const seenInteractionIds = new Map<string, number>();
const INTERACTION_DEDUPE_MS = 15_000;

function stateFilePath(): string {
  const cfg = loadConfig();
  return join(cfg.assistantDir, 'state', 'blips-stream.json');
}

function readStreamState(): StreamStateFile {
  const path = stateFilePath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as StreamStateFile;
  } catch {
    return {};
  }
}

function writeStreamState(state: StreamStateFile): void {
  const path = stateFilePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

function getNextBlipFilename(excludeFilename?: string): string | null {
  const candidates = getBlipsToSurface(20);
  for (const c of candidates) {
    if (excludeFilename && c.filename === excludeFilename) continue;
    return c.filename;
  }
  // If everything is excluded, allow the current one.
  if (excludeFilename) {
    const again = getBlipsToSurface(1)[0];
    return again?.filename || null;
  }
  return null;
}

function excerptBlipContent(raw: string, maxLen: number): string {
  const content = raw.split('\n## Log')[0] || raw;
  const trimmed = content.trim();
  if (!trimmed) return '';
  if (trimmed.length <= maxLen) return trimmed;
  return trimmed.slice(0, maxLen - 1) + '…';
}

function insertMarkdownIntoBlip(path: string, md: string): void {
  const raw = readFileSync(path, 'utf-8');
  const { frontmatter, content } = parseFrontmatter<any>(raw);
  const insert = md.trim();
  if (!insert) return;

  const notesMarker = '## Notes';
  const logMarker = '## Log';
  const notesIndex = content.indexOf(notesMarker);
  const logIndex = content.indexOf(logMarker);

  let nextContent = content.trimEnd();

  // Prefer to place inside Notes when it exists and insert doesn't look like a top-level section.
  const looksLikeTopSection = /^##\s+/m.test(insert);
  if (notesIndex !== -1 && !looksLikeTopSection) {
    const afterNotes = content.slice(notesIndex + notesMarker.length);
    const beforeNotes = content.slice(0, notesIndex + notesMarker.length);
    nextContent = (beforeNotes + `\n\n${insert}\n` + afterNotes).trimEnd();
  } else if (logIndex !== -1) {
    // Otherwise place before Log so Log remains last-ish.
    nextContent = (content.slice(0, logIndex).trimEnd() + `\n\n${insert}\n\n` + content.slice(logIndex)).trimEnd();
  } else {
    nextContent = (content.trimEnd() + `\n\n${insert}\n`).trimEnd();
  }

  writeFileSync(path, serializeFrontmatter(frontmatter, nextContent), 'utf-8');
}

function renderBlipCard(opts: {
  filename: string;
  view?: StreamState['view'];
  prompt?: StreamState['prompt'];
  relatedAi?: StreamState['relatedAi'];
  busy?: StreamState['busy'];
  mode?: 'active' | 'done';
}): {
  flags: number;
  components: any[];
} {
  const filename = opts.filename;
  const cfg = loadConfig();
  const path = join(cfg.blipsDir, filename);
  const blip = readBlip(path);

  const title = blip?.title || filename.replace(/\.md$/i, '');
  const status = blip?.status || 'active';
  const touched = blip?.touched || '';
  const created = blip?.created || '';
  const tags = blip?.tags && blip.tags.length > 0 ? blip.tags.join(', ') : '';

  let statusLine = `Status: ${status}`;
  const snoozedUntil = (blip?.frontmatter as any)?.snoozed_until;
  if (status === 'snoozed' && typeof snoozedUntil === 'string' && snoozedUntil) {
    statusLine += ` (until ${snoozedUntil})`;
  }

  const source = blip?.source ? `Source: ${blip.source}` : '';
  const captureName = (blip?.frontmatter as any)?.capture;
  const capture = typeof captureName === 'string' && captureName ? `Capture: ${captureName}` : '';

  const moves = blip ? suggestMoves(blip).filter((m) => !['snooze', 'archive', 'bump-to-project'].includes(m.move)) : [];
  const moveLine = moves.length > 0 ? `Suggested: ${moves.slice(0, 3).map((m) => m.label).join(' · ')}` : '';

  const mode = opts.mode || 'active';
  const busy = opts.busy;
  const busyLine =
    mode === 'active' && busy
      ? busy.kind === 'ai_related'
        ? '_Working: finding AI-related blips…_'
        : busy.kind === 'prompt'
          ? '_Working: generating prompts…_'
          : '_Working: picking an AI move…_'
      : '';
  const meta = [
    `**${title}**`,
    [statusLine, touched ? `touched ${touched}` : '', created ? `created ${created}` : ''].filter(Boolean).join(' · '),
    tags ? `Tags: ${tags}` : '',
    source,
    capture,
    moveLine || 'Do move: ask AI to pick one helpful move, log it, advance.',
    busyLine,
  ]
    .filter(Boolean)
    .join('\n');

  let excerpt = blip ? excerptBlipContent(blip.content, 450) : '';
  const view = opts.view || 'normal';
  if (view === 'related' && blip) {
    const relatedAi = opts.relatedAi && opts.relatedAi.forFilename === filename ? opts.relatedAi : null;
    const aiItems = relatedAi ? relatedAi.items.slice(0, 3) : [];
    let aiText = '';
    if (relatedAi) {
      if (relatedAi.status === 'loading') {
        aiText = `\n\n**AI related:** _searching…_`;
      } else if (relatedAi.status === 'error') {
        aiText = `\n\n**AI related:** _error: ${(relatedAi.error || 'unknown error').slice(0, 200)}_`;
      } else if (aiItems.length > 0) {
        aiText = `\n\n**AI related:**\n${aiItems.map((r) => `- ${r.title} (${r.filename})`).join('\n')}`;
      } else {
        aiText = `\n\n**AI related:** _none_`;
      }
    }

    const relatedPaths = findRelated(blip.path);
    const keywordRelated = relatedPaths
      .map((p) => {
        const b = readBlip(p);
        const fn = basename(p);
        return b ? { title: b.title, filename: fn } : { title: fn.replace(/\.md$/i, ''), filename: fn };
      })
      .slice(0, 3);

    const relatedText =
      keywordRelated.length > 0
        ? `\n\n**Related:**\n${keywordRelated.map((r) => `- ${r.title} (${r.filename})`).join('\n')}`
        : `\n\n_No obvious related blips found._`;

    excerpt = (excerpt || '') + (aiText || '') + relatedText;
  }
  if (view === 'prompt' && opts.prompt && opts.prompt.questions.length > 0) {
    excerpt =
      (excerpt || '') +
      `\n\n**Questions:**\n${opts.prompt.questions.map((q) => `- ${q}`).join('\n')}\n\n(Use **Answer** to respond, or **Skip**.)`;
  }

  const header: any = { type: ComponentType.TextDisplay, content: meta };
  const sep: any = { type: ComponentType.Separator };
  const body: any = {
    type: ComponentType.TextDisplay,
    content: excerpt ? excerpt : '_No content found for this blip._',
  };

  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${BLIPS_STREAM_CUSTOM_ID_PREFIX}next:${filename}`)
      .setLabel('Next')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${BLIPS_STREAM_CUSTOM_ID_PREFIX}thoughts:${filename}`)
      .setLabel('Thoughts')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${BLIPS_STREAM_CUSTOM_ID_PREFIX}do:${filename}`)
      .setLabel('AI move')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${BLIPS_STREAM_CUSTOM_ID_PREFIX}prompt:${filename}`)
      .setLabel('Prompt')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${BLIPS_STREAM_CUSTOM_ID_PREFIX}archive:${filename}`)
      .setLabel('Archive')
      .setStyle(ButtonStyle.Danger)
  );

  const row2Buttons: ButtonBuilder[] = [
    new ButtonBuilder()
      .setCustomId(`${BLIPS_STREAM_CUSTOM_ID_PREFIX}snooze1:${filename}`)
      .setLabel('Snooze 1d')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${BLIPS_STREAM_CUSTOM_ID_PREFIX}snooze7:${filename}`)
      .setLabel('Snooze 7d')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${BLIPS_STREAM_CUSTOM_ID_PREFIX}snooze30:${filename}`)
      .setLabel('Snooze 30d')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${BLIPS_STREAM_CUSTOM_ID_PREFIX}related:${filename}`)
      .setLabel(view === 'related' ? 'Back' : 'Related')
      .setStyle(ButtonStyle.Secondary),
    view === 'related'
      ? new ButtonBuilder()
          .setCustomId(`${BLIPS_STREAM_CUSTOM_ID_PREFIX}ai_related:${filename}`)
          .setLabel('AI related')
          .setStyle(ButtonStyle.Secondary)
      : new ButtonBuilder()
          .setCustomId(`${BLIPS_STREAM_CUSTOM_ID_PREFIX}bump:${filename}`)
          .setLabel('Bump')
          .setStyle(ButtonStyle.Secondary),
  ];

  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(...row2Buttons);

  let row3: ActionRowBuilder<ButtonBuilder> | null = null;
  if (view === 'prompt') {
    row3 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${BLIPS_STREAM_CUSTOM_ID_PREFIX}answer:${filename}`)
        .setLabel('Answer')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`${BLIPS_STREAM_CUSTOM_ID_PREFIX}skip:${filename}`)
        .setLabel('Skip')
        .setStyle(ButtonStyle.Secondary)
    );
  }

  if (mode === 'done') {
    for (const b of (row1.components as ButtonBuilder[])) b.setDisabled(true);
    for (const b of (row2.components as ButtonBuilder[])) b.setDisabled(true);
    if (row3) for (const b of (row3.components as ButtonBuilder[])) b.setDisabled(true);
  }

  const container: any = {
    type: ComponentType.Container,
    components: [header, sep, body, row1.toJSON(), row2.toJSON()],
  };
  if (row3) container.components.push(row3.toJSON());

  return { flags: MessageFlags.IsComponentsV2, components: [container] };
}

async function resolveBlipsStreamChannel(guild: Guild, blipsStreamId?: string): Promise<TextChannel | null> {
  if (blipsStreamId) {
    const ch = await guild.channels.fetch(blipsStreamId).catch(() => null);
    if (ch && ch.isTextBased() && ch.type === ChannelType.GuildText) return ch as TextChannel;
  }

  const channels = await guild.channels.fetch();
  for (const ch of channels.values()) {
    if (!ch) continue;
    if (ch.type !== ChannelType.GuildText) continue;
    if (typeof ch.name === 'string' && ch.name.toLowerCase() === 'blips-stream') {
      return ch as TextChannel;
    }
  }
  return null;
}

export async function ensureBlipsStreamCard(opts: {
  client: Client;
  guild: Guild;
  blipsStreamChannelId?: string;
}): Promise<void> {
  const channel = await resolveBlipsStreamChannel(opts.guild, opts.blipsStreamChannelId);
  if (!channel) return;

  const state = readStreamState();
  const slot = (state[channel.id] ||= {});

  const filename = slot.currentFilename || getNextBlipFilename() || null;
  if (!filename) return;

  const payload = renderBlipCard({
    filename,
    view: slot.view,
    prompt: slot.prompt,
    relatedAi: slot.relatedAi,
    busy: slot.busy,
  });
  slot.currentFilename = filename;

  if (slot.messageId) {
    const msg = await channel.messages.fetch(slot.messageId).catch(() => null);
    if (msg) {
      await msg.edit(payload as any).catch(() => {});
      writeStreamState(state);
      return;
    }
  }

  const sent = await channel.send(payload as any).catch(() => null);
  if (sent) {
    slot.messageId = sent.id;
    writeStreamState(state);
  }
}

function blipPathFromFilename(filename: string): string {
  const cfg = loadConfig();
  return join(cfg.blipsDir, filename);
}

function addDaysIso(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

export function isBlipsStreamCustomId(customId: string): boolean {
  return customId.startsWith(BLIPS_STREAM_CUSTOM_ID_PREFIX) || customId.startsWith(BLIPS_STREAM_MODAL_PREFIX);
}

async function maybeSendTyping(interaction: ButtonInteraction): Promise<void> {
  const ch: any = interaction.channel as any;
  if (!ch) return;
  const fn = ch.sendTyping;
  if (typeof fn !== 'function') return;
  await fn.call(ch).catch(() => {});
}

async function refreshInPlace(message: Message, filename: string | null): Promise<void> {
  if (!filename) {
    await message.edit({
      flags: MessageFlags.IsComponentsV2,
      components: [
        {
          type: ComponentType.Container,
          components: [
            { type: ComponentType.TextDisplay, content: '**Blips Stream**\n\n_No blips ready right now._' },
          ],
        },
      ],
    } as any);
    return;
  }
  const state = readStreamState();
  const slot = state[message.channelId] || {};
  await message.edit(
    renderBlipCard({ filename, view: slot.view, prompt: slot.prompt, relatedAi: slot.relatedAi, busy: slot.busy }) as any
  );
}

async function sendNewCard(message: Message, filename: string | null): Promise<Message | null> {
  if (!filename) return null;
  const state = readStreamState();
  const slot = state[message.channelId] || {};
  const ch = message.channel as TextChannel;
  const sent = await ch
    .send(renderBlipCard({ filename, view: slot.view, prompt: slot.prompt, relatedAi: slot.relatedAi, busy: slot.busy }) as any)
    .catch(() => null);
  return sent as any;
}

async function advanceCard(message: Message, currentFilename?: string): Promise<void> {
  const next = getNextBlipFilename(currentFilename) || null;
  const state = readStreamState();
  const slot = (state[message.channelId] ||= {});
  slot.view = 'normal';
  delete slot.busy;
  delete slot.prompt;
  delete slot.relatedAi;
  writeStreamState(state);

  // Finalize the current card in-place so it remains in history.
  if (currentFilename) {
    await message.edit(renderBlipCard({ filename: currentFilename, mode: 'done' }) as any).catch(() => {});
  }

  // Post the next blip as a new message.
  const nextMsg = await sendNewCard(message, next);
  slot.messageId = nextMsg?.id;
  slot.currentFilename = next || undefined;
  writeStreamState(state);
}

async function advanceCardFallback(client: Client, guild: Guild | null, channelId: string, currentFilename?: string): Promise<void> {
  const next = getNextBlipFilename(currentFilename) || null;
  const state = readStreamState();
  const slot = (state[channelId] ||= {});
  slot.view = 'normal';
  delete slot.busy;
  delete slot.prompt;
  slot.currentFilename = next || undefined;
  writeStreamState(state);

  if (guild) {
    await ensureBlipsStreamCard({ client, guild, blipsStreamChannelId: channelId }).catch(() => {});
  }
}

async function getStreamMessageForChannel(client: Client, channelId: string): Promise<Message | null> {
  const state = readStreamState();
  const slot = state[channelId];
  const messageId = slot?.messageId;
  if (!messageId) return null;

  const ch = await client.channels.fetch(channelId).catch(() => null);
  if (!ch || !ch.isTextBased() || ch.type !== ChannelType.GuildText) return null;

  const msg = await (ch as TextChannel).messages.fetch(messageId).catch(() => null);
  return msg || null;
}

export async function handleBlipsStreamButton(interaction: ButtonInteraction): Promise<void> {
  const customId = interaction.customId;
  if (!customId.startsWith(BLIPS_STREAM_CUSTOM_ID_PREFIX)) return;

  const now = Date.now();
  for (const [k, t] of seenInteractionIds) {
    if (now - t > INTERACTION_DEDUPE_MS) seenInteractionIds.delete(k);
  }
  if (seenInteractionIds.has(interaction.id)) {
    await interaction.deferUpdate().catch(() => {});
    return;
  }
  seenInteractionIds.set(interaction.id, now);

  const rest = customId.slice(BLIPS_STREAM_CUSTOM_ID_PREFIX.length);
  const [verb, filename] = rest.split(':', 2);
  if (!verb || !filename) return;

  const message = interaction.message as Message;
  const state = readStreamState();
  const slot = state[interaction.channelId] || {};
  const current = slot.currentFilename;

  // Stale safety: if the button is for a different blip than the current card, just refresh.
  if (current && filename !== current) {
    await interaction.reply({ content: 'That card is no longer active.', ephemeral: true }).catch(() => {});
    return;
  }

  if (verb === 'thoughts') {
    const modal = new ModalBuilder()
      .setCustomId(`${BLIPS_STREAM_MODAL_PREFIX}thoughts:${message.id}:${filename}`)
      .setTitle('Add thoughts to blip');

    const input = new TextInputBuilder()
      .setCustomId('thoughts')
      .setLabel('Thoughts')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(1000);

    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    await interaction.showModal(modal).catch(() => {});
    return;
  }

  if (verb === 'bump') {
    const modal = new ModalBuilder()
      .setCustomId(`${BLIPS_STREAM_MODAL_PREFIX}bump:${message.id}:${filename}`)
      .setTitle('Bump blip to project');

    const input = new TextInputBuilder()
      .setCustomId('path')
      .setLabel('Project path (relative or absolute)')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(200);

    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    await interaction.showModal(modal).catch(() => {});
    return;
  }

  if (verb === 'answer') {
    const modal = new ModalBuilder()
      .setCustomId(`${BLIPS_STREAM_MODAL_PREFIX}answer:${message.id}:${filename}`)
      .setTitle('Answer prompts');

    const input = new TextInputBuilder()
      .setCustomId('answer')
      .setLabel('Your answers (freeform)')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(1500);

    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    await interaction.showModal(modal).catch(() => {});
    return;
  }

  await interaction.deferUpdate().catch(() => {});

  const path = blipPathFromFilename(filename);
  if (verb === 'archive') {
    archiveBlip(path);
    await advanceCard(message, filename);
    return;
  }

  if (verb === 'next') {
    touchBlip(path);
    await advanceCard(message, filename);
    return;
  }

  if (verb === 'related') {
    const state2 = readStreamState();
    const slot2 = (state2[interaction.channelId] ||= {});
    if (slot2.view === 'related') {
      slot2.view = 'normal';
      delete slot2.relatedAi;
    } else {
      slot2.view = 'related';
    }
    writeStreamState(state2);
    await refreshInPlace(message, filename);
    return;
  }

  if (verb === 'ai_related') {
    const blip = readBlip(path);
    if (!blip) {
      await advanceCard(message, filename);
      return;
    }

    const state2 = readStreamState();
    const slot2 = (state2[interaction.channelId] ||= {});
    slot2.view = 'related';
    slot2.busy = { kind: 'ai_related', at: new Date().toISOString() };
    slot2.relatedAi = { forFilename: filename, status: 'loading', items: [], at: new Date().toISOString() };
    writeStreamState(state2);
    await refreshInPlace(message, filename);
    await maybeSendTyping(interaction);

    try {
      const cfg = loadConfig();
      const blipsDir = cfg.blipsDir;

      const prompt = `You are helping a personal blips system.\n\nYou are currently running in a directory full of markdown blips.\nYour job: find up to 3 *related* blips to the target blip.\n\nTarget blip:\nTitle: ${blip.title}\nTags: ${(blip.tags || []).join(', ')}\nSource: ${blip.source || ''}\nContent excerpt:\n${excerptBlipContent(blip.content, 1200)}\n\nUse any Claude Code tools you want (Glob/Grep/Read, etc.) to explore the blips.\nPrefer semantic relatedness (same theme, same project, same question) over exact keyword matches.\n\nOutput ONLY JSON: {\"related\":[\"filename.md\", ...]}\n`;

      const res = await invokeClaude(prompt, { model: 'haiku', cwd: blipsDir, timeoutMs: 3 * 60 * 1000 });
      let filenames: string[] = [];
      try {
        const parsed = JSON.parse((res.text || '').trim());
        if (Array.isArray(parsed?.related)) {
          filenames = parsed.related.filter((f: any) => typeof f === 'string' && f.trim()).slice(0, 3);
        }
      } catch {}

      const items = filenames
        .map((fn) => {
          try {
            const p = join(blipsDir, fn);
            const b = readBlip(p);
            if (!b) return null;
            return { filename: fn, title: b.title || fn.replace(/\.md$/i, '') };
          } catch {
            return null;
          }
        })
        .filter(Boolean) as Array<{ filename: string; title: string }>;

      const state3 = readStreamState();
      const slot3 = (state3[interaction.channelId] ||= {});
      slot3.view = 'related';
      delete slot3.busy;
      slot3.relatedAi = { forFilename: filename, status: 'done', items, at: new Date().toISOString() };
      writeStreamState(state3);
      await refreshInPlace(message, filename);
      return;
    } catch (e: any) {
      const state3 = readStreamState();
      const slot3 = (state3[interaction.channelId] ||= {});
      slot3.view = 'related';
      delete slot3.busy;
      slot3.relatedAi = {
        forFilename: filename,
        status: 'error',
        items: [],
        at: new Date().toISOString(),
        error: e?.message || String(e),
      };
      writeStreamState(state3);
      await refreshInPlace(message, filename);
      return;
    }
  }

  if (verb === 'prompt') {
    const blip = readBlip(path);
    if (!blip) {
      await advanceCard(message, filename);
      return;
    }

    const state0 = readStreamState();
    const slot0 = (state0[interaction.channelId] ||= {});
    slot0.busy = { kind: 'prompt', at: new Date().toISOString() };
    writeStreamState(state0);
    await refreshInPlace(message, filename);
    await maybeSendTyping(interaction);

    const prompt = `You are helping a personal blips system.\n\nHere is a blip:\n\nTitle: ${blip.title}\nStatus: ${blip.status}\nContent:\n${blip.content.slice(0, 2500)}\n\nWrite 1-3 short, concrete questions that would help the user update this blip (progress, changes, direction, next step). If no questions are helpful, output an empty list.\n\nOutput ONLY JSON: {\"questions\": [\"...\"]}\n`;
    const res = await invokeClaude(prompt, { model: 'haiku' });
    let qs: string[] = [];
    try {
      const parsed = JSON.parse((res.text || '').trim());
      if (Array.isArray(parsed?.questions)) {
        qs = parsed.questions.filter((q: any) => typeof q === 'string' && q.trim()).slice(0, 3);
      }
    } catch {}

    const state2 = readStreamState();
    const slot2 = (state2[interaction.channelId] ||= {});
    slot2.view = 'prompt';
    delete slot2.busy;
    delete slot2.relatedAi;
    slot2.prompt = { questions: qs.length > 0 ? qs : ['What’s changed since you captured this?', 'Any new examples, constraints, or direction?', 'What would be a tiny next step?'] };
    writeStreamState(state2);
    await refreshInPlace(message, filename);
    return;
  }

  if (verb === 'skip') {
    await advanceCard(message, filename);
    return;
  }

  if (verb === 'snooze7') {
    snoozeBlip(path, addDaysIso(7));
    await advanceCard(message, filename);
    return;
  }

  if (verb === 'snooze1') {
    snoozeBlip(path, addDaysIso(1));
    await advanceCard(message, filename);
    return;
  }

  if (verb === 'snooze30') {
    snoozeBlip(path, addDaysIso(30));
    await advanceCard(message, filename);
    return;
  }

  if (verb === 'do') {
    const blip = readBlip(path);
    if (!blip) {
      await advanceCard(message, filename);
      return;
    }

    const state0 = readStreamState();
    const slot0 = (state0[interaction.channelId] ||= {});
    slot0.busy = { kind: 'ai_move', at: new Date().toISOString() };
    writeStreamState(state0);
    await refreshInPlace(message, filename);
    await maybeSendTyping(interaction);

    const suggestions = suggestMoves(blip).map((m) => ({ move: m.move, label: m.label, description: m.description }));

    const prompt = `You are an assistant helping evolve a personal blip.\n\nBlip title: ${blip.title}\nBlip status: ${blip.status}\nBlip content:\n${blip.content.slice(0, 3000)}\n\nCandidate moves:\n${suggestions.map((s) => `- ${s.move}: ${s.label} (${s.description})`).join('\n')}\n\nPick ONE move that is likely to be helpful *now*.\nThen produce a tiny update for the blip:\n- logLine: a short log entry describing what happened\n- section: optional markdown section to append (can be empty)\n- questions: optional 0-2 questions for the user to consider later (empty if not needed)\n\nOutput ONLY JSON with keys: {\"move\":\"...\",\"logLine\":\"...\",\"section\":\"...\",\"questions\":[\"...\"]}\n`;

    const res = await invokeClaude(prompt, { model: 'haiku' });
    let out: any = null;
    try {
      out = JSON.parse((res.text || '').trim());
    } catch {
      out = null;
    }

    const logLine = typeof out?.logLine === 'string' && out.logLine.trim() ? out.logLine.trim() : 'Did a suggested move.';
    const section = typeof out?.section === 'string' ? out.section.trim() : '';
    const qs = Array.isArray(out?.questions) ? out.questions.filter((q: any) => typeof q === 'string' && q.trim()).slice(0, 2) : [];

    if (section) insertMarkdownIntoBlip(path, section);
    appendToLog(path, `Move: ${typeof out?.move === 'string' ? out.move : 'unknown'} — ${logLine}`);
    if (qs.length > 0) {
      appendToLog(path, `Questions:\n${qs.map((q: string) => `- ${q}`).join('\n')}`);
    }

    await advanceCard(message, filename);
    return;
  }
}

export async function handleBlipsStreamModal(interaction: ModalSubmitInteraction): Promise<void> {
  const customId = interaction.customId;
  if (!customId.startsWith(BLIPS_STREAM_MODAL_PREFIX)) return;

  const rest = customId.slice(BLIPS_STREAM_MODAL_PREFIX.length);
  const parts = rest.split(':');
  const verb = parts[0] || '';
  const legacyFilename = parts[1] || '';
  const messageId = parts.length >= 3 ? parts[1] || '' : '';
  const filename = parts.length >= 3 ? parts.slice(2).join(':') || '' : legacyFilename;
  if (!verb) return;

  await interaction.deferUpdate().catch(() => {});

  // Prefer message id encoded in modal customId (most reliable); fallback to state lookup.
  let streamMsg: Message | null = null;
  if (messageId && interaction.channelId) {
    const ch = await interaction.client.channels.fetch(interaction.channelId).catch(() => null);
    if (ch && ch.isTextBased() && ch.type === ChannelType.GuildText) {
      streamMsg = await (ch as TextChannel).messages.fetch(messageId).catch(() => null);
    }
  }

  const path = blipPathFromFilename(filename);
  if (!streamMsg && interaction.channelId) {
    streamMsg = await getStreamMessageForChannel(interaction.client as any, interaction.channelId);
  }

  if (verb === 'thoughts') {
    const thoughts = interaction.fields.getTextInputValue('thoughts').trim();
    if (thoughts) appendToLog(path, `Thoughts: ${thoughts}`);
    if (streamMsg) {
      await advanceCard(streamMsg, filename);
    } else if (interaction.channelId) {
      await advanceCardFallback(interaction.client as any, interaction.guild as any, interaction.channelId, filename);
    }
    return;
  }

  if (verb === 'bump') {
    const projectPath = interaction.fields.getTextInputValue('path').trim();
    if (projectPath) bumpToProject(path, projectPath);
    if (streamMsg) {
      await advanceCard(streamMsg, filename);
    } else if (interaction.channelId) {
      await advanceCardFallback(interaction.client as any, interaction.guild as any, interaction.channelId, filename);
    }
    return;
  }

  if (verb === 'answer') {
    const answer = interaction.fields.getTextInputValue('answer').trim();
    const state = readStreamState();
    const channelId = interaction.channelId;
    const slot = channelId ? state[channelId] : undefined;
    const qs = slot?.prompt?.questions || [];
    if (qs.length > 0) {
      appendToLog(path, `Prompt answers:\n${qs.map((q: string, i: number) => `${i + 1}. ${q}`).join('\n')}\n\n${answer}`);
    } else if (answer) {
      appendToLog(path, `Prompt answers:\n${answer}`);
    }
    if (streamMsg) {
      await advanceCard(streamMsg, filename);
    } else if (interaction.channelId) {
      await advanceCardFallback(interaction.client as any, interaction.guild as any, interaction.channelId, filename);
    }
    return;
  }
}
