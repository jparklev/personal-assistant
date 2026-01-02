/**
 * Process clippings from Web Clipper into blips
 *
 * Web Clipper saves to Clippings/ with its own frontmatter format.
 * We add blip fields and move to Blips/.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, unlinkSync } from 'fs';
import { join, basename } from 'path';
import { loadConfig } from '../config';
import { parseFrontmatter, serializeFrontmatter } from '../utils/frontmatter';
import { ensureBlipsDir } from './files';
import type { BlipFrontmatter, BlipStatus } from './types';

const config = loadConfig();

interface ClippingFrontmatter {
  title?: string;
  source?: string;
  author?: string | string[];
  published?: string;
  created?: string;
  description?: string;
  tags?: string[];
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
 * Normalize author field (can be string or array)
 */
function normalizeAuthor(author: string | string[] | undefined): string | undefined {
  if (!author) return undefined;
  if (Array.isArray(author)) {
    return author[0]; // Take first author
  }
  return author;
}

/**
 * Process all clippings in the Clippings folder
 * Returns the number of clippings processed
 */
export function processClippings(): number {
  if (!existsSync(config.clippingsDir)) {
    return 0;
  }

  ensureBlipsDir();

  const files = readdirSync(config.clippingsDir).filter((f) => f.endsWith('.md'));
  let processed = 0;

  for (const filename of files) {
    const sourcePath = join(config.clippingsDir, filename);

    try {
      const raw = readFileSync(sourcePath, 'utf-8');
      const { frontmatter: clipFm, content } = parseFrontmatter<ClippingFrontmatter>(raw);

      // Build blip frontmatter
      const title = clipFm.title || filename.replace('.md', '');
      const created = clipFm.created || new Date().toISOString().split('T')[0];

      const blipFm: BlipFrontmatter = {
        title,
        status: 'active' as BlipStatus,
        created,
        touched: created,
        tags: clipFm.tags?.filter((t) => t !== 'clippings') || [],
        related: [],
      };

      if (clipFm.source) {
        blipFm.source = clipFm.source;
      }

      const author = normalizeAuthor(clipFm.author);
      if (author) {
        blipFm.author = author;
      }

      if (clipFm.published) {
        blipFm.published = clipFm.published;
      }

      // Build new content with log section
      let newContent = content;

      // Add description as first paragraph if present
      if (clipFm.description && !content.includes(clipFm.description)) {
        newContent = clipFm.description + '\n\n' + content;
      }

      // Add log section if not present
      if (!newContent.includes('## Log')) {
        newContent += `\n\n## Log\n\n- **${created}**: Clipped from web`;
      }

      // Generate new path with collision handling
      let slug = slugify(title);
      if (!slug) slug = 'untitled';

      let newFilename = `${created}-${slug}.md`;
      let destPath = join(config.blipsDir, newFilename);
      let counter = 1;

      while (existsSync(destPath)) {
        newFilename = `${created}-${slug}-${counter}.md`;
        destPath = join(config.blipsDir, newFilename);
        counter++;
      }

      // Write to Blips/
      writeFileSync(destPath, serializeFrontmatter(blipFm, newContent), 'utf-8');

      // Remove from Clippings/
      unlinkSync(sourcePath);

      processed++;
    } catch (err) {
      // Log error but continue with other files
      console.error(`Error processing clipping ${filename}:`, err);
    }
  }

  return processed;
}

/**
 * Get list of pending clippings (without processing them)
 */
export function listPendingClippings(): string[] {
  if (!existsSync(config.clippingsDir)) {
    return [];
  }

  return readdirSync(config.clippingsDir).filter((f) => f.endsWith('.md'));
}
