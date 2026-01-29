/**
 * Captures Module
 *
 * Captures content from URLs, YouTube videos, podcasts, etc.
 * Saves to the Obsidian vault's Clippings/ folder with frontmatter for searchability.
 *
 * Uses progressive disclosure:
 * - Index contains metadata only (title, url, type, date, tags)
 * - Full content loaded on-demand via file read
 */

import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { parseFrontmatter } from '../utils/frontmatter';
import { isoDateForAssistant } from '../time';
import { loadConfig } from '../config';

/** Get the captures directory (vault's Clippings folder) */
export function getCapturesDir(): string {
  return loadConfig().clippingsDir;
}

/** @deprecated Use getCapturesDir() instead */
export const CAPTURES_DIR = getCapturesDir();

// Ensure captures directory exists
export function ensureCapturesDir(): void {
  mkdirSync(getCapturesDir(), { recursive: true });
}

export interface CaptureMetadata {
  title: string;
  url: string;
  type: 'article' | 'youtube' | 'podcast' | 'pdf' | 'other';
  capturedAt: string;
  tags?: string[];
  description?: string;
  author?: string;
}

export interface CaptureResult {
  success: boolean;
  filePath?: string;
  error?: string;
}

/**
 * Generate a safe filename from a title
 */
function safeFilename(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 60);
}

// Podcast platform patterns
const PODCAST_PATTERNS = [
  'podcasts.apple.com',
  'spotify.com/episode',
  'spotify.com/show',
  'pocketcasts.com',
  'pca.st',
  'overcast.fm',
  'castro.fm',
  'podbean.com',
  'anchor.fm',
  'soundcloud.com',
  'stitcher.com',
  'podchaser.com',
  'player.fm',
  '/feed',
  '.rss',
  '/rss',
];

/**
 * Detect content type from URL
 */
export function detectContentType(url: string): CaptureMetadata['type'] {
  const lower = url.toLowerCase();

  if (lower.includes('youtube.com') || lower.includes('youtu.be')) {
    return 'youtube';
  }

  // Check podcast patterns
  if (PODCAST_PATTERNS.some((pattern) => lower.includes(pattern))) {
    return 'podcast';
  }

  if (lower.endsWith('.pdf')) {
    return 'pdf';
  }

  return 'article';
}

/**
 * Generate frontmatter for a capture file
 */
export function generateFrontmatter(meta: CaptureMetadata): string {
  const lines = [
    '---',
    `title: "${meta.title.replace(/"/g, '\\"')}"`,
    `url: "${meta.url}"`,
    `type: ${meta.type}`,
    `captured: ${meta.capturedAt}`,
  ];

  if (meta.author) {
    lines.push(`author: "${meta.author.replace(/"/g, '\\"').slice(0, 200)}"`);
  }

  if (meta.tags && meta.tags.length > 0) {
    lines.push(`tags: [${meta.tags.map((t) => `"${t}"`).join(', ')}]`);
  }

  if (meta.description) {
    lines.push(`description: "${meta.description.replace(/"/g, '\\"').slice(0, 200)}"`);
  }

  lines.push('---', '');
  return lines.join('\n');
}

/**
 * Save captured content to a file
 */
export function saveCapture(
  meta: CaptureMetadata,
  content: string,
  opts?: { now?: Date }
): CaptureResult {
  ensureCapturesDir();

  const capturesDir = getCapturesDir();
  const date = isoDateForAssistant(opts?.now || new Date());
  const filename = `${date}-${safeFilename(meta.title)}.md`;
  const filePath = join(capturesDir, filename);

  // Check for duplicate
  if (existsSync(filePath)) {
    return { success: false, error: `File already exists: ${filename}` };
  }

  const frontmatter = generateFrontmatter(meta);
  const fullContent = `${frontmatter}\n# ${meta.title}\n\n**Source:** ${meta.url}\n\n---\n\n${content}`;

  try {
    writeFileSync(filePath, fullContent, 'utf-8');
    return { success: true, filePath };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * List recent captures (filenames only)
 */
export function listCaptures(limit: number = 10): string[] {
  ensureCapturesDir();
  const capturesDir = getCapturesDir();

  try {
    const files = readdirSync(capturesDir)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .reverse()
      .slice(0, limit);
    return files;
  } catch {
    return [];
  }
}

/**
 * Capture index entry (lightweight metadata only)
 */
export interface CaptureIndexEntry {
  filename: string;
  title: string;
  url: string;
  type: CaptureMetadata['type'];
  captured: string;
  tags?: string[];
  description?: string;
  author?: string;
}

/**
 * Build index from capture files (frontmatter only)
 */
export function buildCapturesIndex(): CaptureIndexEntry[] {
  ensureCapturesDir();
  const capturesDir = getCapturesDir();

  const files = readdirSync(capturesDir).filter((f) => f.endsWith('.md'));
  const entries: CaptureIndexEntry[] = [];

  for (const filename of files) {
    const path = join(capturesDir, filename);
    try {
      const raw = readFileSync(path, 'utf-8');
      const { frontmatter } = parseFrontmatter<{
        title?: string;
        url?: string;
        type?: string;
        captured?: string;
        tags?: string[];
        description?: string;
        author?: string;
      }>(raw);

      entries.push({
        filename,
        title: frontmatter.title || filename.replace('.md', ''),
        url: frontmatter.url || '',
        type: (frontmatter.type as CaptureMetadata['type']) || 'other',
        captured: frontmatter.captured || '',
        tags: frontmatter.tags,
        description: frontmatter.description,
        author: frontmatter.author,
      });
    } catch {
      // Skip malformed files
    }
  }

  // Sort by captured date descending
  entries.sort((a, b) => (b.captured || '').localeCompare(a.captured || ''));

  return entries;
}

/**
 * Format captures index for context injection
 */
export function formatCapturesForContext(limit: number = 20): string {
  const index = buildCapturesIndex();
  const entries = limit ? index.slice(0, limit) : index;

  if (entries.length === 0) {
    return '## Captures\n\nNo captures yet.';
  }

  const lines = [
    `## Captures Index (${index.length} total)`,
    '',
    '| Date | Type | Title | Tags |',
    '|------|------|-------|------|',
  ];

  for (const entry of entries) {
    const date = entry.captured.split('T')[0] || '-';
    const title = entry.title.slice(0, 40) + (entry.title.length > 40 ? '...' : '');
    const tags = entry.tags?.join(', ') || '';
    lines.push(`| ${date} | ${entry.type} | ${title} | ${tags} |`);
  }

  lines.push('', `To read full capture: Clippings/<filename>`);

  return lines.join('\n');
}

/**
 * Get captures from the last N days
 */
export function getRecentCaptures(days: number = 7): CaptureIndexEntry[] {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString();

  return buildCapturesIndex().filter((c) => c.captured >= cutoffStr);
}

/**
 * Extract URLs from a message
 */
export function extractUrls(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi;
  return text.match(urlRegex) || [];
}
