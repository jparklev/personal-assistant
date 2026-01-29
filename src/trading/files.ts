import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type { TradeSummary, TradeStatus, WatchedAssetSummary } from './types';

function safeRead(path: string, maxBytes: number): string {
  if (!existsSync(path)) return '';
  try {
    const raw = readFileSync(path);
    if (raw.length > maxBytes) return raw.subarray(0, maxBytes).toString('utf-8') + '\n…';
    return raw.toString('utf-8');
  } catch {
    return '';
  }
}

function writeNewFile(path: string, content: string): void {
  if (existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content.endsWith('\n') ? content : content + '\n', 'utf-8');
}

function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, 'utf-8');
  renameSync(tmp, path);
}

function writeFileIfChanged(path: string, next: string): boolean {
  const prev = safeRead(path, 5_000_000);
  if (prev === next) return false;
  writeFileAtomic(path, next);
  return true;
}

export function tradingDirPath(vaultPath: string): string {
  return join(vaultPath, 'Trading');
}

export function ensureTradingFiles(vaultPath: string): void {
  const dir = tradingDirPath(vaultPath);
  mkdirSync(dir, { recursive: true });

  writeNewFile(
    join(dir, 'Claude.md'),
    [
      '# Trading Assistant',
      '',
      'This is my trading assistant’s evolving understanding: how I trade, what I’m optimizing for, and what I’m trying to learn.',
      '',
      '## Principles',
      '',
      '- Keep risk bounded; survive first.',
      '- Write the thesis, then trade the thesis.',
      '- Review outcomes; extract lessons.',
      '',
    ].join('\n')
  );

  writeNewFile(
    join(dir, 'Philosophy.md'),
    ['# Philosophy', '', 'High-level inspirations, mental models, and rules of thumb.', ''].join('\n')
  );

  writeNewFile(
    join(dir, 'Money-Management.md'),
    [
      '# Money Management',
      '',
      'Rules for sizing, stops/invalidation, max loss, and when to sit out.',
      '',
      '## Defaults',
      '',
      '- I define invalidation before entry (even if it’s “thesis invalidation”).',
      '- I prefer fewer, higher-conviction positions.',
      '',
    ].join('\n')
  );

  writeNewFile(
    join(dir, 'Ideas.md'),
    [
      '# Ideas',
      '',
      "Assets I'm watching, theses, and conditions for entry/exit.",
      '',
      '---',
      '',
      '## Idea Log',
      '',
      'Quick captures before they’re organized:',
      '',
    ].join('\n')
  );

  writeNewFile(
    join(dir, 'Trades.md'),
    [
      '# Trades',
      '',
      '---',
      '',
      '## Template',
      '',
      '**Symbol**:',
      '**Direction**:',
      '**Entry**:',
      '**Size**:',
      '**Thesis**:',
      '**Invalidation/Stop** (optional):',
      '**Risk** (optional):',
      '**Status**: Open',
      '',
      '### Entry Reasoning',
      '',
      '(to be filled)',
      '',
      '### Updates',
      '',
      '- (date): (note)',
      '',
      '### Exit',
      '',
      '(to be filled)',
      '',
      '### Reflection',
      '',
      '(to be filled)',
      '',
    ].join('\n')
  );

  writeNewFile(
    join(dir, 'Lessons.md'),
    [
      '# Lessons',
      '',
      '---',
      '',
      '## Template',
      '',
      '**From trade**:',
      '',
      '(what happened, what I learned, what pattern to watch)',
      '',
    ].join('\n')
  );
}

export function readTradingFile(vaultPath: string, filename: string, maxBytes = 200_000): string {
  const p = join(tradingDirPath(vaultPath), filename);
  return safeRead(p, maxBytes);
}

function normalizeSingleLine(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\u0000/g, '')
    .trim();
}

function findHeadingLineIndex(lines: string[], heading: string): number {
  const want = heading.trim().toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]?.trim().toLowerCase() === want) return i;
  }
  return -1;
}

function findNextHeadingIndex(lines: string[], start: number, headingPrefix: string): number {
  for (let i = start; i < lines.length; i++) {
    if (lines[i]?.startsWith(headingPrefix)) return i;
  }
  return lines.length;
}

/**
 * Append a dated bullet to Trading/Ideas.md -> "## Idea Log".
 *
 * This is intentionally conservative: it never rewrites content besides inserting the new bullet.
 */
export function appendIdeaLogEntry(vaultPath: string, entry: { date: string; time: string; text: string }): boolean {
  ensureTradingFiles(vaultPath);
  const ideasPath = join(tradingDirPath(vaultPath), 'Ideas.md');

  const raw = safeRead(ideasPath, 5_000_000);
  const lines = raw ? raw.split(/\r?\n/) : [];

  const heading = '## Idea Log';
  let headingIdx = findHeadingLineIndex(lines, heading);
  if (headingIdx === -1) {
    // Create the heading at end.
    if (lines.length > 0 && lines[lines.length - 1]?.trim() !== '') lines.push('');
    headingIdx = lines.length;
    lines.push(heading, '', 'Quick captures before they’re organized:', '');
  }

  const sectionStart = headingIdx + 1;
  const sectionEnd = findNextHeadingIndex(lines, sectionStart, '## ');
  const bulletText = normalizeSingleLine(entry.text);
  if (!bulletText) return false;

  const bullet = `- **${entry.date} ${entry.time}**: ${bulletText}`;

  // Avoid exact duplicates.
  for (let i = sectionStart; i < sectionEnd; i++) {
    if (lines[i]?.trim() === bullet.trim()) return false;
  }

  // Insert just before the next H2 (or EOF).
  const insertAt = sectionEnd;
  lines.splice(insertAt, 0, bullet);

  const next = lines.join('\n') + '\n';
  return writeFileIfChanged(ideasPath, next);
}

function takeFirstLines(text: string, maxLines: number): string {
  const lines = text.split(/\r?\n/);
  return lines.slice(0, maxLines).join('\n').trim();
}

function parseBoldField(block: string, field: string): string | undefined {
  // e.g. **Status**: Open
  const re = new RegExp(`^\\*\\*${field}\\*\\*\\s*:\\s*(.+)\\s*$`, 'mi');
  const m = block.match(re);
  return m?.[1]?.trim();
}

export function parseTradesMarkdown(markdown: string): TradeSummary[] {
  const out: TradeSummary[] = [];
  const parts = markdown.split(/\n##\s+/g);
  if (parts.length <= 1) return out;

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    const firstNewline = part.indexOf('\n');
    const title = (firstNewline === -1 ? part : part.slice(0, firstNewline)).trim();
    const body = firstNewline === -1 ? '' : part.slice(firstNewline + 1);
    if (!title) continue;

    const statusRaw = parseBoldField(body, 'Status') || '';
    const status: TradeStatus = statusRaw.toLowerCase().startsWith('closed') ? 'Closed' : 'Open';
    const symbol = parseBoldField(body, 'Symbol');
    const direction = parseBoldField(body, 'Direction');
    const entry = parseBoldField(body, 'Entry');

    out.push({ title, status, symbol, direction, entry });
  }

  return out;
}

export function listOpenTrades(vaultPath: string, limit = 10): TradeSummary[] {
  const raw = readTradingFile(vaultPath, 'Trades.md', 250_000);
  const trades = parseTradesMarkdown(raw);
  return trades.filter((t) => t.status === 'Open').slice(0, limit);
}

export function parseIdeasMarkdown(markdown: string): WatchedAssetSummary[] {
  const out: WatchedAssetSummary[] = [];

  const parts = markdown.split(/\n##\s+/g);
  if (parts.length <= 1) return out;

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    const firstNewline = part.indexOf('\n');
    const header = (firstNewline === -1 ? part : part.slice(0, firstNewline)).trim();
    const body = firstNewline === -1 ? '' : part.slice(firstNewline + 1);
    if (!header) continue;
    if (header.toLowerCase() === 'idea log') continue;
    if (header.toLowerCase() === 'template') continue;

    const thesis = parseBoldField(body, 'Thesis');
    out.push({ asset: header, thesis });
  }

  return out;
}

export function listWatchedAssets(vaultPath: string, limit = 10): WatchedAssetSummary[] {
  const raw = readTradingFile(vaultPath, 'Ideas.md', 250_000);
  const assets = parseIdeasMarkdown(raw);
  return assets.slice(0, limit);
}

export function readTradingClaudeIntro(vaultPath: string, maxLines = 50): string {
  const raw = readTradingFile(vaultPath, 'Claude.md', 100_000);
  return takeFirstLines(raw, maxLines);
}
