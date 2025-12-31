import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { nanoid } from 'nanoid';
import type { Blip, BlipCategory, BlipMove, BlipsState, BlipSource, BlipState, BlipSurfaceResult } from './types';
import { defaultBlipsState } from './types';

const ASSISTANT_DIR = join(homedir(), '.assistant');
const BLIPS_FILE = join(ASSISTANT_DIR, 'blips.json');

export class BlipStore {
  private state: BlipsState;
  private filePath: string;

  constructor(filePath: string = BLIPS_FILE) {
    this.filePath = filePath;
    this.ensureDir();
    this.state = this.loadFromDisk();
  }

  get snapshot(): BlipsState {
    return this.state;
  }

  get all(): Blip[] {
    return this.state.blips;
  }

  // Capture a new blip
  capture(content: string, source: BlipSource, category?: BlipCategory): Blip {
    const blip: Blip = {
      id: nanoid(10),
      content: content.trim(),
      source,
      state: 'captured',
      category,
      capturedAt: new Date().toISOString(),
      surfaceCount: 0,
      notes: [],
    };

    this.state.blips.push(blip);
    this.saveToDisk();
    return blip;
  }

  // Find a blip by ID
  findById(id: string): Blip | undefined {
    return this.state.blips.find((b) => b.id === id);
  }

  // Update a blip's state
  updateState(id: string, newState: BlipState): boolean {
    const blip = this.findById(id);
    if (!blip) return false;

    blip.state = newState;
    blip.lastUpdatedAt = new Date().toISOString();
    this.saveToDisk();
    return true;
  }

  // Add a note to a blip
  addNote(id: string, note: string): boolean {
    const blip = this.findById(id);
    if (!blip) return false;

    blip.notes.push(note);
    blip.lastUpdatedAt = new Date().toISOString();

    // If blip was captured, move to incubating since user engaged with it
    if (blip.state === 'captured') {
      blip.state = 'incubating';
    }

    this.saveToDisk();
    return true;
  }

  // Schedule a blip to resurface later
  snooze(id: string, days: number): boolean {
    const blip = this.findById(id);
    if (!blip) return false;

    const nextSurface = new Date();
    nextSurface.setDate(nextSurface.getDate() + days);
    blip.nextSurfaceAfter = nextSurface.toISOString();
    blip.state = 'incubating';
    blip.lastUpdatedAt = new Date().toISOString();

    this.saveToDisk();
    return true;
  }

  // Archive a blip
  archive(id: string): boolean {
    return this.updateState(id, 'archived');
  }

  // Mark blip as surfaced
  markSurfaced(id: string): boolean {
    const blip = this.findById(id);
    if (!blip) return false;

    blip.surfaceCount++;
    blip.lastSurfacedAt = new Date().toISOString();
    this.saveToDisk();
    return true;
  }

  // Link a blip to another blip
  linkBlips(id1: string, id2: string): boolean {
    const blip1 = this.findById(id1);
    const blip2 = this.findById(id2);
    if (!blip1 || !blip2) return false;

    blip1.linkedBlips = blip1.linkedBlips ?? [];
    blip2.linkedBlips = blip2.linkedBlips ?? [];

    if (!blip1.linkedBlips.includes(id2)) blip1.linkedBlips.push(id2);
    if (!blip2.linkedBlips.includes(id1)) blip2.linkedBlips.push(id1);

    this.saveToDisk();
    return true;
  }

  // Link a blip to a vault path
  linkToVault(id: string, vaultPath: string): boolean {
    const blip = this.findById(id);
    if (!blip) return false;

    blip.linkedVaultPaths = blip.linkedVaultPaths ?? [];
    if (!blip.linkedVaultPaths.includes(vaultPath)) {
      blip.linkedVaultPaths.push(vaultPath);
    }

    this.saveToDisk();
    return true;
  }

  // Promote a blip to the vault
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

    this.saveToDisk();
    return true;
  }

  // Add tags to a blip
  addTags(id: string, tags: string[]): boolean {
    const blip = this.findById(id);
    if (!blip) return false;

    blip.tags = blip.tags ?? [];
    for (const tag of tags) {
      if (!blip.tags.includes(tag)) {
        blip.tags.push(tag);
      }
    }

    this.saveToDisk();
    return true;
  }

  // Get blips ready to surface
  getSurfaceableBlips(limit: number = 5): BlipSurfaceResult[] {
    const now = new Date();
    const today = now.toISOString().split('T')[0];

    // Filter blips that can be surfaced
    const candidates = this.state.blips.filter((b) => {
      // Only surface active states
      if (!['captured', 'incubating', 'active'].includes(b.state)) return false;

      // Respect snooze
      if (b.nextSurfaceAfter && new Date(b.nextSurfaceAfter) > now) return false;

      return true;
    });

    // Score and sort
    const scored = candidates.map((blip) => {
      let score = 0;
      let reason = '';

      // Never surfaced - high priority
      if (!blip.lastSurfacedAt) {
        score += 100;
        reason = 'New blip';
      } else {
        // Days since last surfaced
        const daysSinceSurface = Math.floor(
          (now.getTime() - new Date(blip.lastSurfacedAt).getTime()) / 86400000
        );
        score += daysSinceSurface * 10;
        reason = `Not seen in ${daysSinceSurface} days`;
      }

      // Recently captured gets a boost
      const hoursSinceCapture = Math.floor(
        (now.getTime() - new Date(blip.capturedAt).getTime()) / 3600000
      );
      if (hoursSinceCapture < 24) {
        score += 50;
        reason = 'Recently captured';
      }

      // Active blips get priority
      if (blip.state === 'active') {
        score += 30;
        reason = 'Active blip';
      }

      // Has notes - user engaged with it
      if (blip.notes.length > 0) {
        score += 20;
      }

      // Low surface count - less familiar
      if (blip.surfaceCount < 3) {
        score += 15;
      }

      return { blip, score, reason };
    });

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // Take top N and generate suggested moves
    return scored.slice(0, limit).map(({ blip, reason }) => ({
      blip,
      reason,
      suggestedMoves: this.suggestMoves(blip),
    }));
  }

  // Suggest moves for a blip
  private suggestMoves(blip: Blip): BlipMove[] {
    const moves: BlipMove[] = ['elaborate', 'snooze', 'archive'];

    if (blip.surfaceCount >= 3) {
      // Surfaced enough times - maybe ready to promote or archive
      moves.unshift('promote');
    }

    if (blip.state === 'captured') {
      // New blip - encourage engagement
      moves.unshift('question');
    }

    if (blip.notes.length >= 2) {
      // Has notes - might be ready to connect or promote
      moves.unshift('connect');
    }

    return moves.slice(0, 4);
  }

  // Get blips by state
  getByState(state: BlipState): Blip[] {
    return this.state.blips.filter((b) => b.state === state);
  }

  // Get blips by category
  getByCategory(category: BlipCategory): Blip[] {
    return this.state.blips.filter((b) => b.category === category);
  }

  // Get recent blips
  getRecent(limit: number = 10): Blip[] {
    return [...this.state.blips]
      .sort((a, b) => new Date(b.capturedAt).getTime() - new Date(a.capturedAt).getTime())
      .slice(0, limit);
  }

  // Search blips by content
  search(query: string): Blip[] {
    const lower = query.toLowerCase();
    return this.state.blips.filter(
      (b) =>
        b.content.toLowerCase().includes(lower) ||
        b.notes.some((n) => n.toLowerCase().includes(lower)) ||
        b.tags?.some((t) => t.toLowerCase().includes(lower))
    );
  }

  // Get statistics
  getStats(): { total: number; byState: Record<BlipState, number>; byCategory: Record<string, number> } {
    const byState: Record<string, number> = {};
    const byCategory: Record<string, number> = {};

    for (const blip of this.state.blips) {
      byState[blip.state] = (byState[blip.state] || 0) + 1;
      const cat = blip.category || 'uncategorized';
      byCategory[cat] = (byCategory[cat] || 0) + 1;
    }

    return {
      total: this.state.blips.length,
      byState: byState as Record<BlipState, number>,
      byCategory,
    };
  }

  // Persistence
  private ensureDir(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
  }

  private loadFromDisk(): BlipsState {
    if (!existsSync(this.filePath)) {
      return defaultBlipsState();
    }

    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);

      if (parsed.version !== 1) {
        return defaultBlipsState();
      }

      return {
        ...defaultBlipsState(),
        ...parsed,
      };
    } catch {
      return defaultBlipsState();
    }
  }

  private saveToDisk(): void {
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2) + '\n', 'utf-8');
    renameSync(tmp, this.filePath);
  }
}

// Singleton for easy import
let _store: BlipStore | null = null;

export function getBlipStore(): BlipStore {
  if (!_store) {
    _store = new BlipStore();
  }
  return _store;
}
