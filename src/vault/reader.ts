import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import type { ClipperHighlight, DailyNote, FollowupItem, GoalsDocument, VaultFile } from './types';

export class VaultReader {
  constructor(private vaultPath: string) {}

  exists(): boolean {
    return existsSync(this.vaultPath);
  }

  readFile(relativePath: string): VaultFile | null {
    const fullPath = join(this.vaultPath, relativePath);
    if (!existsSync(fullPath)) return null;

    try {
      const stat = statSync(fullPath);
      if (!stat.isFile()) return null;

      return {
        path: relativePath,
        content: readFileSync(fullPath, 'utf-8'),
        modifiedAt: stat.mtime,
      };
    } catch {
      return null;
    }
  }

  listFiles(folder: string, extension?: string): string[] {
    const fullPath = join(this.vaultPath, folder);
    if (!existsSync(fullPath)) return [];

    try {
      const entries = readdirSync(fullPath, { withFileTypes: true });
      return entries
        .filter((e) => e.isFile())
        .filter((e) => !extension || e.name.endsWith(extension))
        .map((e) => join(folder, e.name));
    } catch {
      return [];
    }
  }

  // Parse a daily note file
  parseDailyNote(date: string): DailyNote | null {
    const file = this.readFile(`Daily/${date}.md`);
    if (!file) return null;

    const lines = file.content.split('\n');
    const followups: FollowupItem[] = [];
    const tags: string[] = [];

    lines.forEach((line, idx) => {
      // Extract #tags
      const tagMatches = line.match(/#[\w-]+/g);
      if (tagMatches) {
        tags.push(...tagMatches.map((t) => t.slice(1)));
      }

      // Extract followup items (lines with #followups or checkbox items after #followups)
      if (line.includes('#followups') || line.includes('#followup')) {
        // This line or subsequent lines may have followups
      }

      // Extract checkbox items: - [ ] or - [x]
      const checkboxMatch = line.match(/^(\s*)-\s*\[([ x])\]\s*(.+)/i);
      if (checkboxMatch) {
        followups.push({
          text: checkboxMatch[3].trim(),
          completed: checkboxMatch[2].toLowerCase() === 'x',
          line: idx + 1,
        });
      }
    });

    return {
      date,
      content: file.content,
      followups,
      tags: [...new Set(tags)],
    };
  }

  // Get today's daily note
  getTodayNote(): DailyNote | null {
    const today = new Date().toISOString().split('T')[0];
    return this.parseDailyNote(today);
  }

  // Get yesterday's daily note
  getYesterdayNote(): DailyNote | null {
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    return this.parseDailyNote(yesterday);
  }

  // Parse the goals document
  // Handles format with plain text headers like "Who do I want to be"
  parseGoals(path: string = '2026 Goals.md'): GoalsDocument | null {
    const file = this.readFile(path);
    if (!file) return null;

    const goals: string[] = [];
    const mantras: string[] = [];

    const lines = file.content.split('\n');
    let inGoalsSection = false;

    for (const line of lines) {
      const trimmed = line.trim();

      // Detect section headers (with or without #)
      // "Who do I want to be", "What do I want to do", etc.
      if (trimmed.match(/^(#+\s*)?(who do i want|what do i want|goals?|aspirations)/i)) {
        inGoalsSection = true;
        continue;
      }
      // New section that's not goals
      if (trimmed.match(/^(#+\s*)?(who do i want to be more like|and to think)/i)) {
        inGoalsSection = false;
        continue;
      }
      // Any header ends the current section
      if (trimmed.match(/^#+\s/)) {
        inGoalsSection = false;
        continue;
      }

      // Extract list items (top-level only, not indented sub-items)
      const listMatch = line.match(/^[-*]\s+(.+)/);
      if (listMatch && inGoalsSection) {
        goals.push(listMatch[1]);
      }
    }

    return {
      path,
      goals,
      mantras,
      rawContent: file.content,
    };
  }

  // Parse Note Inbox for captured concepts
  parseNoteInbox(): string[] {
    const file = this.readFile('Note Inbox.md');
    if (!file) return [];

    const concepts: string[] = [];
    const lines = file.content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      // Look for list items or standalone terms
      const listMatch = trimmed.match(/^[-*]\s+(.+)/);
      if (listMatch) {
        concepts.push(listMatch[1]);
      }
    }

    return concepts;
  }

  // Parse Obsidian Clipper files in Clippings/ folder
  parseClipperFiles(): ClipperHighlight[] {
    const files = this.listFiles('Clippings', '.md');
    const highlights: ClipperHighlight[] = [];

    for (const filePath of files) {
      const file = this.readFile(filePath);
      if (!file) continue;

      const parsed = this.parseClipperFile(file.content, filePath);
      highlights.push(...parsed);
    }

    return highlights;
  }

  // Parse a single clipper file
  private parseClipperFile(content: string, sourcePath: string): ClipperHighlight[] {
    const highlights: ClipperHighlight[] = [];
    const lines = content.split('\n');

    let sourceTitle: string | undefined;
    let sourceUrl: string | undefined;
    let currentHighlight: string[] = [];
    let currentNote: string | undefined;

    // First line is often the title
    if (lines[0]?.startsWith('# ')) {
      const titleLine = lines[0].slice(2);
      // Format might be "Title | Source" or just "Title"
      const parts = titleLine.split('|').map((p) => p.trim());
      sourceTitle = parts[0];
      if (parts[1]) sourceUrl = parts[1];
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // Highlights are quoted with >
      if (trimmed.startsWith('>')) {
        const highlightText = trimmed.slice(1).trim();
        if (highlightText) {
          currentHighlight.push(highlightText);
        }
      } else if (currentHighlight.length > 0) {
        // End of highlight block, next non-empty line might be a note
        if (trimmed && !trimmed.startsWith('#')) {
          currentNote = trimmed;
        }

        // Save the highlight
        const id = `${sourcePath}:${highlights.length}`;
        highlights.push({
          id,
          text: currentHighlight.join(' '),
          sourceFile: sourcePath,
          sourceUrl,
          sourceTitle,
          note: currentNote,
        });

        currentHighlight = [];
        currentNote = undefined;
      }
    }

    // Handle any remaining highlight
    if (currentHighlight.length > 0) {
      const id = `${sourcePath}:${highlights.length}`;
      highlights.push({
        id,
        text: currentHighlight.join(' '),
        sourceFile: sourcePath,
        sourceUrl,
        sourceTitle,
        note: currentNote,
      });
    }

    return highlights;
  }

  // Get Claude's memory file from vault
  getClaudeNotes(): string | null {
    const file = this.readFile('.claude/notes.md');
    return file?.content ?? null;
  }

  // Get all recent daily notes (last N days)
  getRecentDailyNotes(days: number = 7): DailyNote[] {
    const notes: DailyNote[] = [];
    const now = Date.now();

    for (let i = 0; i < days; i++) {
      const date = new Date(now - i * 86400000).toISOString().split('T')[0];
      const note = this.parseDailyNote(date);
      if (note) notes.push(note);
    }

    return notes;
  }

  // Get incomplete followups from recent daily notes
  getIncompleteFollowups(days: number = 7): { date: string; items: FollowupItem[] }[] {
    const notes = this.getRecentDailyNotes(days);
    return notes
      .map((note) => ({
        date: note.date,
        items: note.followups.filter((f) => !f.completed),
      }))
      .filter((n) => n.items.length > 0);
  }
}
