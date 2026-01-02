/**
 * Blip surfacing logic
 *
 * Pick blips to show based on age and status.
 * Find related blips via grep.
 */

import { readFileSync } from 'fs';
import { basename } from 'path';
import { loadConfig } from '../config';
import { parseFrontmatter } from '../utils/frontmatter';
import { listBlips, readBlip } from './files';
import type { BlipSummary, BlipFrontmatter, Blip } from './types';

const config = loadConfig();

/**
 * Get blips to surface (oldest-first, filter snoozed)
 */
export function getBlipsToSurface(count: number = 3): BlipSummary[] {
  const blips = listBlips();
  const now = new Date();

  // Filter: active, or snoozed but ready
  const surfaceable = blips.filter((b) => {
    if (b.status === 'active') return true;

    if (b.status === 'snoozed') {
      // Need to read full blip to check snoozed_until
      const full = readBlip(b.path);
      if (full && full.frontmatter.snoozed_until) {
        return new Date(full.frontmatter.snoozed_until) <= now;
      }
    }

    return false;
  });

  // Sort by last touched (oldest first)
  surfaceable.sort((a, b) => {
    const dateA = new Date(a.touched || '1970-01-01');
    const dateB = new Date(b.touched || '1970-01-01');
    return dateA.getTime() - dateB.getTime();
  });

  return surfaceable.slice(0, count);
}

/**
 * Extract keywords from blip content for grep
 */
function extractKeywords(blip: Blip): string[] {
  const keywords: string[] = [];

  // Extract from title
  const titleWords = blip.title
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 3);
  keywords.push(...titleWords);

  // Extract from tags
  if (blip.tags) {
    keywords.push(...blip.tags);
  }

  // Extract wikilinks from content
  const wikilinks = blip.content.match(/\[\[([^\]]+)\]\]/g) || [];
  for (const link of wikilinks) {
    keywords.push(link.slice(2, -2).toLowerCase());
  }

  // Dedupe
  return [...new Set(keywords)];
}

/**
 * Find related blips by searching file contents
 * Uses file reads instead of shell grep to avoid injection risks
 */
export function findRelated(blipPath: string): string[] {
  const blip = readBlip(blipPath);
  if (!blip) return [];

  const keywords = extractKeywords(blip);
  if (keywords.length === 0) return [];

  const related: Set<string> = new Set();
  const currentFilename = basename(blipPath);

  // Get all blip files
  const allBlips = listBlips();

  for (const otherBlip of allBlips) {
    if (otherBlip.filename === currentFilename) continue;

    // Check if any keyword matches in title or tags
    const lowerTitle = otherBlip.title.toLowerCase();
    const lowerTags = (otherBlip.tags || []).map((t) => t.toLowerCase());

    for (const keyword of keywords.slice(0, 5)) {
      if (lowerTitle.includes(keyword) || lowerTags.some((t) => t.includes(keyword))) {
        related.add(otherBlip.path);
        break;
      }
    }

    // Stop if we have enough
    if (related.size >= 5) break;
  }

  return [...related];
}

/**
 * Get a summary of all active blips for listing
 */
export function getActiveBlipsSummary(): string {
  const blips = listBlips().filter((b) => b.status === 'active');

  if (blips.length === 0) {
    return 'No active blips.';
  }

  const lines = [`**Active Blips (${blips.length})**`, ''];

  for (const blip of blips) {
    const date = blip.touched || blip.created || '';
    const tags = blip.tags?.length ? ` [${blip.tags.join(', ')}]` : '';
    const source = blip.source ? ' (link)' : '';
    lines.push(`- **${blip.title}**${tags}${source} - ${date}`);
  }

  return lines.join('\n');
}

/**
 * Format a blip for display
 */
export function formatBlipForDisplay(blip: Blip): string {
  const lines: string[] = [];

  lines.push(`# ${blip.title}`);
  lines.push('');

  if (blip.source) {
    lines.push(`**Source:** ${blip.source}`);
  }

  lines.push(`**Status:** ${blip.status}`);
  lines.push(`**Last touched:** ${blip.touched}`);

  if (blip.tags?.length) {
    lines.push(`**Tags:** ${blip.tags.join(', ')}`);
  }

  lines.push('');
  lines.push('---');
  lines.push('');

  // First part of content (before ## sections)
  const firstSection = blip.content.split(/^##/m)[0].trim();
  if (firstSection) {
    lines.push(firstSection);
  }

  return lines.join('\n');
}
