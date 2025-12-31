/**
 * File-based Blip Store
 *
 * Each blip is a markdown file with YAML frontmatter:
 * ~/.assistant/blips/<id>.md
 *
 * Index is built from frontmatter only for context priming.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { nanoid } from 'nanoid';
import { parseFrontmatter, serializeFrontmatter } from '../utils/frontmatter';
import type { Blip, BlipCategory, BlipMove, BlipSource, BlipState, BlipSurfaceResult } from './types';

const ASSISTANT_DIR = join(homedir(), '.assistant');
const BLIPS_DIR = join(ASSISTANT_DIR, 'blips');

/**
 * Frontmatter structure for blip files
 */
interface BlipFrontmatter {
  id: string;
  state: BlipState;
  category?: BlipCategory;
  captured: string;
  surfaced?: string;
  updated?: string;
  surface_count: number;
  next_surface?: string;
  tags?: string[];
  source_type: string;
  source_ref?: string;
  linked_blips?: string[];
  linked_vault?: string[];
  promoted_to?: string;
}

/**
 * Lightweight index entry for context priming
 */
export interface BlipIndexEntry {
  id: string;
  state: BlipState;
  category?: BlipCategory;
  summary: string; // First ~80 chars of content
  tags?: string[];
  captured: string;
  surfaced?: string;
}

export class FileBlipStore {
  private blipsDir: string;

  constructor(blipsDir: string = BLIPS_DIR) {
    this.blipsDir = blipsDir;
    this.ensureDir();
  }

  private ensureDir(): void {
    mkdirSync(this.blipsDir, { recursive: true });
  }

  private blipPath(id: string): string {
    return join(this.blipsDir, `${id}.md`);
  }

  /**
   * Build lightweight index from frontmatter only
   * This is what gets injected into context
   */
  buildIndex(): BlipIndexEntry[] {
    const files = this.listBlipFiles();
    const entries: BlipIndexEntry[] = [];

    for (const file of files) {
      const id = file.replace('.md', '');
      const path = join(this.blipsDir, file);

      try {
        const raw = readFileSync(path, 'utf-8');
        const { frontmatter, content } = parseFrontmatter<BlipFrontmatter>(raw);

        entries.push({
          id: frontmatter.id || id,
          state: frontmatter.state || 'captured',
          category: frontmatter.category,
          summary: content.slice(0, 80).replace(/\n/g, ' ').trim(),
          tags: frontmatter.tags,
          captured: frontmatter.captured,
          surfaced: frontmatter.surfaced,
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
   * Format index for context injection
   */
  formatIndexForContext(limit?: number): string {
    const index = this.buildIndex();
    const entries = limit ? index.slice(0, limit) : index;

    if (entries.length === 0) {
      return '## Blips\n\nNo blips yet.';
    }

    const lines = [
      `## Blips Index (${index.length} total)`,
      '',
      '| ID | State | Category | Summary | Tags |',
      '|----|-------|----------|---------|------|',
    ];

    for (const entry of entries) {
      const tags = entry.tags?.join(', ') || '';
      const summary = entry.summary.slice(0, 50) + (entry.summary.length > 50 ? '...' : '');
      lines.push(`| ${entry.id} | ${entry.state} | ${entry.category || '-'} | ${summary} | ${tags} |`);
    }

    lines.push('', `To read full blip: ~/.assistant/blips/<id>.md`);

    return lines.join('\n');
  }

  /**
   * List all blip files
   */
  private listBlipFiles(): string[] {
    try {
      return readdirSync(this.blipsDir).filter((f) => f.endsWith('.md'));
    } catch {
      return [];
    }
  }

  /**
   * Capture a new blip
   */
  capture(content: string, source: BlipSource, category?: BlipCategory): Blip {
    const id = nanoid(10);
    const now = new Date().toISOString();

    const blip: Blip = {
      id,
      content: content.trim(),
      source,
      state: 'captured',
      category,
      capturedAt: now,
      surfaceCount: 0,
      notes: [],
    };

    this.saveBlip(blip);
    return blip;
  }

  /**
   * Load a blip by ID
   */
  findById(id: string): Blip | undefined {
    const path = this.blipPath(id);
    if (!existsSync(path)) return undefined;

    try {
      return this.loadBlip(path, id);
    } catch {
      return undefined;
    }
  }

  /**
   * Load all blips (use sparingly - prefer index)
   */
  get all(): Blip[] {
    return this.listBlipFiles().map((f) => {
      const id = f.replace('.md', '');
      return this.loadBlip(join(this.blipsDir, f), id);
    }).filter((b): b is Blip => b !== undefined);
  }

  /**
   * Update a blip's state
   */
  updateState(id: string, newState: BlipState): boolean {
    const blip = this.findById(id);
    if (!blip) return false;

    blip.state = newState;
    blip.lastUpdatedAt = new Date().toISOString();
    this.saveBlip(blip);
    return true;
  }

  /**
   * Add a note to a blip
   */
  addNote(id: string, note: string): boolean {
    const blip = this.findById(id);
    if (!blip) return false;

    blip.notes.push(note);
    blip.lastUpdatedAt = new Date().toISOString();

    if (blip.state === 'captured') {
      blip.state = 'incubating';
    }

    this.saveBlip(blip);
    return true;
  }

  /**
   * Snooze a blip
   */
  snooze(id: string, days: number): boolean {
    const blip = this.findById(id);
    if (!blip) return false;

    const nextSurface = new Date();
    nextSurface.setDate(nextSurface.getDate() + days);
    blip.nextSurfaceAfter = nextSurface.toISOString();
    blip.state = 'incubating';
    blip.lastUpdatedAt = new Date().toISOString();

    this.saveBlip(blip);
    return true;
  }

  /**
   * Archive a blip
   */
  archive(id: string): boolean {
    return this.updateState(id, 'archived');
  }

  /**
   * Mark blip as surfaced
   */
  markSurfaced(id: string): boolean {
    const blip = this.findById(id);
    if (!blip) return false;

    blip.surfaceCount++;
    blip.lastSurfacedAt = new Date().toISOString();
    this.saveBlip(blip);
    return true;
  }

  /**
   * Link blips together
   */
  linkBlips(id1: string, id2: string): boolean {
    const blip1 = this.findById(id1);
    const blip2 = this.findById(id2);
    if (!blip1 || !blip2) return false;

    blip1.linkedBlips = blip1.linkedBlips ?? [];
    blip2.linkedBlips = blip2.linkedBlips ?? [];

    if (!blip1.linkedBlips.includes(id2)) blip1.linkedBlips.push(id2);
    if (!blip2.linkedBlips.includes(id1)) blip2.linkedBlips.push(id1);

    this.saveBlip(blip1);
    this.saveBlip(blip2);
    return true;
  }

  /**
   * Link blip to vault path
   */
  linkToVault(id: string, vaultPath: string): boolean {
    const blip = this.findById(id);
    if (!blip) return false;

    blip.linkedVaultPaths = blip.linkedVaultPaths ?? [];
    if (!blip.linkedVaultPaths.includes(vaultPath)) {
      blip.linkedVaultPaths.push(vaultPath);
    }

    this.saveBlip(blip);
    return true;
  }

  /**
   * Promote blip to vault
   */
  promote(id: string, type: 'goal' | 'project' | 'task' | 'note', vaultPath: string): boolean {
    const blip = this.findById(id);
    if (!blip) return false;

    blip.state = 'promoted';
    blip.promotedTo = {
      type,
      vaultPath,
      promotedAt: new Date().toISOString(),
    };
    blip.lastUpdatedAt = new Date().toISOString();

    this.saveBlip(blip);
    return true;
  }

  /**
   * Add tags to blip
   */
  addTags(id: string, tags: string[]): boolean {
    const blip = this.findById(id);
    if (!blip) return false;

    blip.tags = blip.tags ?? [];
    for (const tag of tags) {
      if (!blip.tags.includes(tag)) {
        blip.tags.push(tag);
      }
    }

    this.saveBlip(blip);
    return true;
  }

  /**
   * Get surfaceable blips
   */
  getSurfaceableBlips(limit: number = 5): BlipSurfaceResult[] {
    const now = new Date();
    const blips = this.all;

    const candidates = blips.filter((b) => {
      if (!['captured', 'incubating', 'active'].includes(b.state)) return false;
      if (b.nextSurfaceAfter && new Date(b.nextSurfaceAfter) > now) return false;
      return true;
    });

    const scored = candidates.map((blip) => {
      let score = 0;
      let reason = '';

      if (!blip.lastSurfacedAt) {
        score += 100;
        reason = 'New blip';
      } else {
        const daysSinceSurface = Math.floor(
          (now.getTime() - new Date(blip.lastSurfacedAt).getTime()) / 86400000
        );
        score += daysSinceSurface * 10;
        reason = `Not seen in ${daysSinceSurface} days`;
      }

      const hoursSinceCapture = Math.floor(
        (now.getTime() - new Date(blip.capturedAt).getTime()) / 3600000
      );
      if (hoursSinceCapture < 24) {
        score += 50;
        reason = 'Recently captured';
      }

      if (blip.state === 'active') {
        score += 30;
        reason = 'Active blip';
      }

      if (blip.notes.length > 0) score += 20;
      if (blip.surfaceCount < 3) score += 15;

      return { blip, score, reason };
    });

    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, limit).map(({ blip, reason }) => ({
      blip,
      reason,
      suggestedMoves: this.suggestMoves(blip),
    }));
  }

  private suggestMoves(blip: Blip): BlipMove[] {
    const moves: BlipMove[] = ['elaborate', 'snooze', 'archive'];

    if (blip.surfaceCount >= 3) moves.unshift('promote');
    if (blip.state === 'captured') moves.unshift('question');
    if (blip.notes.length >= 2) moves.unshift('connect');

    return moves.slice(0, 4);
  }

  /**
   * Get blips by state
   */
  getByState(state: BlipState): Blip[] {
    return this.all.filter((b) => b.state === state);
  }

  /**
   * Get blips by category
   */
  getByCategory(category: BlipCategory): Blip[] {
    return this.all.filter((b) => b.category === category);
  }

  /**
   * Get recent blips
   */
  getRecent(limit: number = 10): Blip[] {
    return this.all
      .sort((a, b) => new Date(b.capturedAt).getTime() - new Date(a.capturedAt).getTime())
      .slice(0, limit);
  }

  /**
   * Search blips (loads all - use sparingly)
   */
  search(query: string): Blip[] {
    const lower = query.toLowerCase();
    return this.all.filter(
      (b) =>
        b.content.toLowerCase().includes(lower) ||
        b.notes.some((n) => n.toLowerCase().includes(lower)) ||
        b.tags?.some((t) => t.toLowerCase().includes(lower))
    );
  }

  /**
   * Get statistics
   */
  getStats(): { total: number; byState: Record<BlipState, number>; byCategory: Record<string, number> } {
    const byState: Record<string, number> = {};
    const byCategory: Record<string, number> = {};
    const blips = this.all;

    for (const blip of blips) {
      byState[blip.state] = (byState[blip.state] || 0) + 1;
      const cat = blip.category || 'uncategorized';
      byCategory[cat] = (byCategory[cat] || 0) + 1;
    }

    return {
      total: blips.length,
      byState: byState as Record<BlipState, number>,
      byCategory,
    };
  }

  /**
   * Delete a blip
   */
  delete(id: string): boolean {
    const path = this.blipPath(id);
    if (!existsSync(path)) return false;

    try {
      unlinkSync(path);
      return true;
    } catch {
      return false;
    }
  }

  // ============== File Operations ==============

  private loadBlip(path: string, fallbackId: string): Blip | undefined {
    try {
      const raw = readFileSync(path, 'utf-8');
      const { frontmatter, content } = parseFrontmatter<BlipFrontmatter>(raw);

      // Parse notes from content (## Notes section)
      const notesMatch = content.match(/## Notes\n([\s\S]*?)(?=\n##|$)/);
      const notes: string[] = [];
      if (notesMatch) {
        const notesSection = notesMatch[1];
        const noteLines = notesSection.split('\n- ').slice(1);
        for (const line of noteLines) {
          if (line.trim()) notes.push(line.trim());
        }
      }

      // Main content is everything before ## Notes
      const mainContent = content.split('## Notes')[0].trim();

      // Reconstruct source from frontmatter
      const source = this.parseSource(frontmatter);

      return {
        id: frontmatter.id || fallbackId,
        content: mainContent,
        source,
        state: frontmatter.state || 'captured',
        category: frontmatter.category,
        capturedAt: frontmatter.captured,
        lastSurfacedAt: frontmatter.surfaced,
        lastUpdatedAt: frontmatter.updated,
        surfaceCount: frontmatter.surface_count || 0,
        nextSurfaceAfter: frontmatter.next_surface,
        tags: frontmatter.tags,
        notes,
        linkedBlips: frontmatter.linked_blips,
        linkedVaultPaths: frontmatter.linked_vault,
        promotedTo: frontmatter.promoted_to ? JSON.parse(frontmatter.promoted_to) : undefined,
      };
    } catch {
      return undefined;
    }
  }

  private parseSource(fm: BlipFrontmatter): BlipSource {
    const type = fm.source_type;
    const ref = fm.source_ref;

    switch (type) {
      case 'discord':
        const [channelId, messageId, userId] = (ref || '').split(':');
        return { type: 'discord', channelId, messageId, userId };
      case 'obsidian-inbox':
        return { type: 'obsidian-inbox', filePath: ref || '' };
      case 'clipper':
        const [filePath, highlightId] = (ref || '').split(':');
        return { type: 'clipper', filePath, highlightId };
      case 'daily-note':
        return { type: 'daily-note', date: ref || '' };
      default:
        return { type: 'manual', context: ref };
    }
  }

  private saveBlip(blip: Blip): void {
    const frontmatter: BlipFrontmatter = {
      id: blip.id,
      state: blip.state,
      category: blip.category,
      captured: blip.capturedAt,
      surfaced: blip.lastSurfacedAt,
      updated: blip.lastUpdatedAt,
      surface_count: blip.surfaceCount,
      next_surface: blip.nextSurfaceAfter,
      tags: blip.tags,
      source_type: blip.source.type,
      source_ref: this.serializeSourceRef(blip.source),
      linked_blips: blip.linkedBlips,
      linked_vault: blip.linkedVaultPaths,
      promoted_to: blip.promotedTo ? JSON.stringify(blip.promotedTo) : undefined,
    };

    // Build content
    let content = blip.content;

    if (blip.notes.length > 0) {
      content += '\n\n## Notes\n';
      for (const note of blip.notes) {
        content += `- ${note}\n`;
      }
    }

    const markdown = serializeFrontmatter(frontmatter, content);

    const path = this.blipPath(blip.id);
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, markdown, 'utf-8');
    renameSync(tmp, path);
  }

  private serializeSourceRef(source: BlipSource): string {
    switch (source.type) {
      case 'discord':
        return `${source.channelId}:${source.messageId}:${source.userId}`;
      case 'obsidian-inbox':
        return source.filePath;
      case 'clipper':
        return `${source.filePath}:${source.highlightId}`;
      case 'daily-note':
        return source.date;
      case 'manual':
        return source.context || '';
    }
  }
}

// Singleton
let _fileStore: FileBlipStore | null = null;

export function getFileBlipStore(): FileBlipStore {
  if (!_fileStore) {
    _fileStore = new FileBlipStore();
  }
  return _fileStore;
}
