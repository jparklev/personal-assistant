/**
 * Blip file operations
 *
 * Read/write blips in the Obsidian vault.
 * Uses frontmatter for progressive disclosure.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import { join, basename } from 'path';
import { loadConfig } from '../config';
import { parseFrontmatter, serializeFrontmatter } from '../utils/frontmatter';
import type { BlipFrontmatter, BlipSummary, Blip, BlipStatus } from './types';
import { isoDateForAssistant } from '../time';

const config = loadConfig();

function normalizeSourceUrl(input: string): string {
  const raw = (input || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    u.hash = '';

    const dropKeys = new Set([
      'mcp_test',
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content',
      'utm_id',
      'utm_name',
      'utm_reader',
      'utm_viz_id',
      'gclid',
      'fbclid',
      'mc_cid',
      'mc_eid',
      'ref',
      'ref_src',
      'source',
    ]);

    const params = new URLSearchParams(u.search);
    for (const k of Array.from(params.keys())) {
      if (k.toLowerCase().startsWith('utm_')) params.delete(k);
      else if (dropKeys.has(k)) params.delete(k);
    }
    u.search = params.toString();

    let s = u.toString();
    if (s.endsWith('/') && u.pathname !== '/') s = s.slice(0, -1);
    return s;
  } catch {
    return raw;
  }
}

/**
 * Ensure Blips directory exists
 */
export function ensureBlipsDir(): void {
  if (!existsSync(config.blipsDir)) {
    mkdirSync(config.blipsDir, { recursive: true });
  }
}

/**
 * Generate a slug from a title
 */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 60);
}

/**
 * Get today's date as YYYY-MM-DD
 */
function today(): string {
  return isoDateForAssistant(new Date());
}

/**
 * List all blips from vault (frontmatter only for efficiency)
 */
export function listBlips(): BlipSummary[] {
  ensureBlipsDir();

  const files = readdirSync(config.blipsDir).filter((f) => f.endsWith('.md'));
  const summaries: BlipSummary[] = [];

  for (const filename of files) {
    const path = join(config.blipsDir, filename);
    try {
      const raw = readFileSync(path, 'utf-8');
      const { frontmatter } = parseFrontmatter<BlipFrontmatter>(raw);

      summaries.push({
        path,
        filename,
        title: frontmatter.title || filename.replace('.md', ''),
        status: frontmatter.status || 'active',
        created: frontmatter.created || '',
        touched: frontmatter.touched || '',
        tags: frontmatter.tags,
        source: frontmatter.source,
      });
    } catch {
      // Skip malformed files
    }
  }

  return summaries;
}

export function findBlipBySource(source: string): BlipSummary | null {
  const want = normalizeSourceUrl(source);
  if (!want) return null;

  for (const b of listBlips()) {
    if (!b.source) continue;
    if (normalizeSourceUrl(b.source) === want) return b;
  }
  return null;
}

export function canonicalizeBlipSource(source: string): string {
  return normalizeSourceUrl(source);
}

/**
 * Read full blip content
 */
export function readBlip(path: string): Blip | null {
  try {
    const raw = readFileSync(path, 'utf-8');
    const { frontmatter, content } = parseFrontmatter<BlipFrontmatter>(raw);
    const filename = basename(path);

    return {
      path,
      filename,
      title: frontmatter.title || filename.replace('.md', ''),
      status: frontmatter.status || 'active',
      created: frontmatter.created || '',
      touched: frontmatter.touched || '',
      tags: frontmatter.tags,
      source: frontmatter.source,
      frontmatter,
      content,
      hasLog: content.includes('## Log'),
    };
  } catch {
    return null;
  }
}

export interface CreateBlipOptions {
  title: string;
  content: string;
  source?: string;
  author?: string;
  published?: string;
  tags?: string[];
  capture?: string;
  logEntry?: string;
  now?: Date;
}

/**
 * Generate a unique filename for a blip
 */
function uniqueFilename(baseFilename: string): string {
  let filename = baseFilename;
  let counter = 1;

  while (existsSync(join(config.blipsDir, filename))) {
    const ext = '.md';
    const base = baseFilename.slice(0, -ext.length);
    filename = `${base}-${counter}${ext}`;
    counter++;
  }

  return filename;
}

/**
 * Create a new blip in the vault
 */
export function createBlip(options: CreateBlipOptions): string {
  ensureBlipsDir();

  const date = options.now ? isoDateForAssistant(options.now) : today();
  let slug = slugify(options.title);

  // Handle empty slug
  if (!slug) {
    slug = 'untitled';
  }

  const baseFilename = `${date}-${slug}.md`;
  const filename = uniqueFilename(baseFilename);
  const path = join(config.blipsDir, filename);

  // Build frontmatter
  const frontmatter: BlipFrontmatter = {
    title: options.title,
    status: 'active',
    created: date,
    touched: date,
    tags: options.tags || [],
    related: [],
  };

  if (options.source) {
    frontmatter.source = options.source;
  }
  if (options.author) {
    frontmatter.author = options.author;
  }
  if (options.published) {
    frontmatter.published = options.published;
  }
  if (options.capture) {
    frontmatter.capture = options.capture;
  }

  // Build body
  let body = options.content;

  // Add log section
  const logEntry = options.logEntry || 'Created';
  body += `\n\n## Log\n\n- **${date}**: ${logEntry}`;

  const fullContent = serializeFrontmatter(frontmatter, body);
  writeFileSync(path, fullContent, 'utf-8');

  return path;
}

/**
 * Append an entry to a blip's log section
 */
export function appendToLog(path: string, entry: string): void {
  const raw = readFileSync(path, 'utf-8');
  const { frontmatter, content } = parseFrontmatter<BlipFrontmatter>(raw);

  // Update touched date
  const date = today();
  frontmatter.touched = date;

  // Find or create log section
  let newContent: string;
  const logMarker = '## Log';
  const logIndex = content.indexOf(logMarker);

  if (logIndex !== -1) {
    // Insert after log header
    const afterLog = content.slice(logIndex + logMarker.length);
    const beforeLog = content.slice(0, logIndex + logMarker.length);
    newContent = beforeLog + `\n\n- **${date}**: ${entry}` + afterLog;
  } else {
    // Add log section at end
    newContent = content + `\n\n## Log\n\n- **${date}**: ${entry}`;
  }

  writeFileSync(path, serializeFrontmatter(frontmatter, newContent), 'utf-8');
}

/**
 * Update a blip's status
 */
export function updateStatus(path: string, status: BlipStatus, extra?: Partial<BlipFrontmatter>): void {
  const raw = readFileSync(path, 'utf-8');
  const { frontmatter, content } = parseFrontmatter<BlipFrontmatter>(raw);

  frontmatter.status = status;
  frontmatter.touched = today();

  // Apply extra fields (e.g., snoozed_until, bumped_to)
  if (extra) {
    Object.assign(frontmatter, extra);
  }

  writeFileSync(path, serializeFrontmatter(frontmatter, content), 'utf-8');
}

/**
 * Snooze a blip until a specific date
 */
export function snoozeBlip(path: string, until: string): void {
  updateStatus(path, 'snoozed', { snoozed_until: until });
  appendToLog(path, `Snoozed until ${until}`);
}

/**
 * Archive a blip
 */
export function archiveBlip(path: string): void {
  updateStatus(path, 'archived');
  appendToLog(path, 'Archived');
}

/**
 * Bump a blip to a project
 */
export function bumpToProject(path: string, projectPath: string): void {
  updateStatus(path, 'bumped', { bumped_to: projectPath });
  appendToLog(path, `Bumped to project: ${projectPath}`);
}

/**
 * Touch a blip (update touched date without changing content)
 */
export function touchBlip(path: string): void {
  const raw = readFileSync(path, 'utf-8');
  const { frontmatter, content } = parseFrontmatter<BlipFrontmatter>(raw);

  frontmatter.touched = today();

  writeFileSync(path, serializeFrontmatter(frontmatter, content), 'utf-8');
}
