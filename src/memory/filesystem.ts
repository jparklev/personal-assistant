/**
 * File-System Based Memory Store
 *
 * Implements the patterns from:
 * - Anthropic's Memory Tool (view, create, str_replace, insert, delete)
 * - Skills guide recommendation: "File-System-as-Memory: Simple, transparent,
 *   hierarchical with JSON/YAML and timestamps"
 *
 * Directory structure:
 * ~/.assistant/
 *   context/                    # User context (persistent facts with validity)
 *     user.md                   # Core user facts
 *     goals.md                  # Goals with temporal validity
 *     preferences.md            # Explicit preferences
 *   knowledge/                  # Learned knowledge
 *     patterns.md               # Observed patterns
 *     corrections.md            # Corrections log
 *   state/                      # Operational state (JSON for programmatic access)
 *     scheduled-tasks.json
 *     questions.json
 *   logs/                       # Interaction logs by date
 *   blips.json                  # Blips (high-churn, kept as JSON)
 *   claude.md                   # Assistant's own instructions
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync, renameSync as fsRename } from 'fs';
import { join, dirname, resolve as pathResolve } from 'path';
import { homedir } from 'os';

export const ASSISTANT_DIR = join(homedir(), '.assistant');

// Directory structure
const DIRS = {
  context: join(ASSISTANT_DIR, 'context'),
  knowledge: join(ASSISTANT_DIR, 'knowledge'),
  state: join(ASSISTANT_DIR, 'state'),
  logs: join(ASSISTANT_DIR, 'logs'),
};

// Ensure all directories exist
export function ensureMemoryDirs(): void {
  mkdirSync(ASSISTANT_DIR, { recursive: true });
  Object.values(DIRS).forEach((dir) => mkdirSync(dir, { recursive: true }));
}

// ============== Memory Tool Operations ==============
// Following Anthropic's memory tool patterns

export interface ViewResult {
  type: 'directory' | 'file';
  content: string;
  error?: string;
}

/**
 * View directory contents or file contents
 * Follows Anthropic's memory tool `view` command
 */
export function view(path: string, lineRange?: [number, number]): ViewResult {
  const fullPath = resolvePath(path);

  if (!existsSync(fullPath)) {
    return { type: 'file', content: '', error: `The path ${path} does not exist.` };
  }

  const stat = statSync(fullPath);

  if (stat.isDirectory()) {
    return viewDirectory(fullPath, path);
  } else {
    return viewFile(fullPath, path, lineRange);
  }
}

function viewDirectory(fullPath: string, displayPath: string): ViewResult {
  const entries = readdirSync(fullPath, { withFileTypes: true });
  const lines: string[] = [`Files in ${displayPath}:`];

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue; // Skip hidden files

    const entryPath = join(fullPath, entry.name);
    const stat = statSync(entryPath);
    const size = formatSize(stat.size);
    const indicator = entry.isDirectory() ? '/' : '';

    lines.push(`${size}\t${entry.name}${indicator}`);

    // Show one level deep for directories
    if (entry.isDirectory()) {
      const subEntries = readdirSync(entryPath, { withFileTypes: true }).slice(0, 5);
      for (const sub of subEntries) {
        if (sub.name.startsWith('.')) continue;
        const subPath = join(entryPath, sub.name);
        const subStat = statSync(subPath);
        lines.push(`  ${formatSize(subStat.size)}\t${entry.name}/${sub.name}`);
      }
    }
  }

  return { type: 'directory', content: lines.join('\n') };
}

function viewFile(fullPath: string, displayPath: string, lineRange?: [number, number]): ViewResult {
  const content = readFileSync(fullPath, 'utf-8');
  const lines = content.split('\n');

  let start = 0;
  let end = lines.length;

  if (lineRange) {
    start = Math.max(0, lineRange[0] - 1);
    end = Math.min(lines.length, lineRange[1]);
  }

  const numberedLines = lines.slice(start, end).map((line, i) => {
    const lineNum = (start + i + 1).toString().padStart(6, ' ');
    return `${lineNum}\t${line}`;
  });

  return {
    type: 'file',
    content: `Content of ${displayPath}:\n${numberedLines.join('\n')}`
  };
}

/**
 * Create a new file
 */
export function create(path: string, content: string): { success: boolean; error?: string } {
  const fullPath = resolvePath(path);

  if (existsSync(fullPath)) {
    return { success: false, error: `File ${path} already exists` };
  }

  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, 'utf-8');
  return { success: true };
}

/**
 * Replace text in a file
 */
export function strReplace(path: string, oldStr: string, newStr: string): { success: boolean; error?: string } {
  const fullPath = resolvePath(path);

  if (!existsSync(fullPath)) {
    return { success: false, error: `The path ${path} does not exist.` };
  }

  const content = readFileSync(fullPath, 'utf-8');
  const occurrences = content.split(oldStr).length - 1;

  if (occurrences === 0) {
    return { success: false, error: `No replacement performed, old_str not found in ${path}` };
  }

  if (occurrences > 1) {
    // Find line numbers of occurrences
    const lines = content.split('\n');
    const lineNums: number[] = [];
    lines.forEach((line, i) => {
      if (line.includes(oldStr)) lineNums.push(i + 1);
    });
    return { success: false, error: `Multiple occurrences found at lines: ${lineNums.join(', ')}. Please be more specific.` };
  }

  const newContent = content.replace(oldStr, newStr);
  writeFileSync(fullPath, newContent, 'utf-8');
  return { success: true };
}

/**
 * Insert text at a specific line
 */
export function insert(path: string, lineNum: number, text: string): { success: boolean; error?: string } {
  const fullPath = resolvePath(path);

  if (!existsSync(fullPath)) {
    return { success: false, error: `The path ${path} does not exist.` };
  }

  const content = readFileSync(fullPath, 'utf-8');
  const lines = content.split('\n');

  if (lineNum < 0 || lineNum > lines.length) {
    return { success: false, error: `Invalid line number: ${lineNum}. File has ${lines.length} lines.` };
  }

  lines.splice(lineNum, 0, text);
  writeFileSync(fullPath, lines.join('\n'), 'utf-8');
  return { success: true };
}

/**
 * Delete a file or directory
 */
export function deleteItem(path: string): { success: boolean; error?: string } {
  const fullPath = resolvePath(path);

  if (!existsSync(fullPath)) {
    return { success: false, error: `The path ${path} does not exist.` };
  }

  rmSync(fullPath, { recursive: true, force: true });
  return { success: true };
}

/**
 * Rename/move a file or directory
 */
export function rename(oldPath: string, newPath: string): { success: boolean; error?: string } {
  const fullOld = resolvePath(oldPath);
  const fullNew = resolvePath(newPath);

  if (!existsSync(fullOld)) {
    return { success: false, error: `The path ${oldPath} does not exist.` };
  }

  if (existsSync(fullNew)) {
    return { success: false, error: `The destination ${newPath} already exists.` };
  }

  mkdirSync(dirname(fullNew), { recursive: true });
  fsRename(fullOld, fullNew);
  return { success: true };
}

// ============== Path Security ==============

function resolvePath(path: string): string {
  // Normalize the path
  let normalized = path.replace(/\\/g, '/');

  // Handle /memories prefix (Anthropic convention)
  if (normalized.startsWith('/memories')) {
    normalized = normalized.replace('/memories', ASSISTANT_DIR);
  } else if (!normalized.startsWith(ASSISTANT_DIR)) {
    normalized = join(ASSISTANT_DIR, normalized);
  }

  // Resolve to canonical path
  const resolved = pathResolve(normalized);

  // Security: ensure path is within ASSISTANT_DIR
  if (!resolved.startsWith(ASSISTANT_DIR)) {
    throw new Error(`Path traversal detected: ${path}`);
  }

  return resolved;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

// ============== Convenience Functions ==============

/**
 * Read a memory file and return parsed content
 */
export function readMemory(path: string): string | null {
  const fullPath = resolvePath(path);
  if (!existsSync(fullPath)) return null;
  return readFileSync(fullPath, 'utf-8');
}

/**
 * Write to a memory file (creates if doesn't exist)
 */
export function writeMemory(path: string, content: string): void {
  const fullPath = resolvePath(path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, 'utf-8');
}

/**
 * Append to a memory file
 */
export function appendMemory(path: string, content: string): void {
  const fullPath = resolvePath(path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, { flag: 'a' });
}

/**
 * Read JSON from state directory
 */
export function readState<T>(name: string, defaultValue: T): T {
  const path = join(DIRS.state, `${name}.json`);
  if (!existsSync(path)) return defaultValue;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return defaultValue;
  }
}

/**
 * Write JSON to state directory
 */
export function writeState(name: string, data: unknown): void {
  const path = join(DIRS.state, `${name}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

/**
 * Log an interaction
 */
export function logInteraction(entry: {
  timestamp: string;
  channel: string;
  type: string;
  summary: string;
}): void {
  const today = new Date().toISOString().split('T')[0];
  const path = join(DIRS.logs, `${today}.jsonl`);
  appendMemory(path, JSON.stringify(entry) + '\n');
}

// ============== Structured Memory Files ==============

/**
 * Goals with temporal validity
 * Format in goals.md:
 *
 * # Goals
 *
 * ## Active Goals (2026)
 * - Goal 1 [valid: 2026-01-01 to 2026-12-31]
 * - Goal 2 [valid: 2026-01-01 to 2026-06-30]
 *
 * ## Archived Goals
 * - Old goal [archived: 2025-12-01]
 */
export interface TemporalFact {
  content: string;
  validFrom?: string;
  validTo?: string;
  confidence?: number;
  source?: string;
  updatedAt: string;
}

export function parseTemporalFacts(content: string): TemporalFact[] {
  const facts: TemporalFact[] = [];
  const lines = content.split('\n');

  for (const line of lines) {
    const match = line.match(/^[-*]\s+(.+?)(?:\s*\[(.+?)\])?$/);
    if (match) {
      const text = match[1].trim();
      const meta = match[2];

      const fact: TemporalFact = {
        content: text,
        updatedAt: new Date().toISOString(),
      };

      if (meta) {
        // Parse [valid: YYYY-MM-DD to YYYY-MM-DD]
        const validMatch = meta.match(/valid:\s*(\S+)\s+to\s+(\S+)/);
        if (validMatch) {
          fact.validFrom = validMatch[1];
          fact.validTo = validMatch[2];
        }

        // Parse [confidence: 0.8]
        const confMatch = meta.match(/confidence:\s*([\d.]+)/);
        if (confMatch) {
          fact.confidence = parseFloat(confMatch[1]);
        }

        // Parse [source: vault]
        const srcMatch = meta.match(/source:\s*(\S+)/);
        if (srcMatch) {
          fact.source = srcMatch[1];
        }
      }

      facts.push(fact);
    }
  }

  return facts;
}

export function formatTemporalFact(fact: TemporalFact): string {
  const meta: string[] = [];

  if (fact.validFrom && fact.validTo) {
    meta.push(`valid: ${fact.validFrom} to ${fact.validTo}`);
  }
  if (fact.confidence !== undefined) {
    meta.push(`confidence: ${fact.confidence}`);
  }
  if (fact.source) {
    meta.push(`source: ${fact.source}`);
  }

  const metaStr = meta.length > 0 ? ` [${meta.join(', ')}]` : '';
  return `- ${fact.content}${metaStr}`;
}

// ============== Initialize Default Files ==============

export function initializeMemoryFiles(): void {
  ensureMemoryDirs();

  // Create default user.md if not exists
  const userPath = join(DIRS.context, 'user.md');
  if (!existsSync(userPath)) {
    writeFileSync(userPath, `# User Context

## About
<!-- Core facts about the user -->

## Current Focus
<!-- What they're currently working on -->

## Timezone
America/New_York

## Active Hours
<!-- Observed active hours -->
`, 'utf-8');
  }

  // Create goals.md if not exists
  const goalsPath = join(DIRS.context, 'goals.md');
  if (!existsSync(goalsPath)) {
    writeFileSync(goalsPath, `# Goals

## Active Goals
<!-- Goals with temporal validity -->
<!-- Format: - Goal text [valid: YYYY-MM-DD to YYYY-MM-DD] -->

## Archived Goals
<!-- Goals no longer active -->
`, 'utf-8');
  }

  // Create preferences.md if not exists
  const prefsPath = join(DIRS.context, 'preferences.md');
  if (!existsSync(prefsPath)) {
    writeFileSync(prefsPath, `# User Preferences

## Communication Style
- Encourage thinking, don't just give answers (Math Academy style)
- Be an accountable partner: call out gaps, ask follow-ups

## Interaction Preferences
<!-- Learned preferences about how user likes to interact -->

## Topics of Interest
<!-- Topics the user frequently engages with -->
`, 'utf-8');
  }

  // Create corrections.md if not exists
  const correctionsPath = join(DIRS.knowledge, 'corrections.md');
  if (!existsSync(correctionsPath)) {
    writeFileSync(correctionsPath, `# Corrections Log

Record of corrections to avoid repeating mistakes.

## Recent Corrections
<!-- Format:
### YYYY-MM-DD
- Original: "what I said/did"
- Correction: "what I should have done"
- Context: "relevant context"
-->
`, 'utf-8');
  }

  // Create patterns.md if not exists
  const patternsPath = join(DIRS.knowledge, 'patterns.md');
  if (!existsSync(patternsPath)) {
    writeFileSync(patternsPath, `# Observed Patterns

## Behavioral Patterns
<!-- Patterns observed from user behavior -->

## Temporal Patterns
<!-- Time-based patterns: when user is active, productive, etc -->

## Topic Patterns
<!-- Topics that frequently come up -->
`, 'utf-8');
  }

  // Create memory.md if not exists (used by invoke.ts for context)
  const memoryPath = join(ASSISTANT_DIR, 'memory.md');
  if (!existsSync(memoryPath)) {
    writeFileSync(memoryPath, `---
updated: ${new Date().toISOString().split('T')[0]}
---

## Pointers

Obsidian vault: Set via \`OBSIDIAN_VAULT_PATH\` env var (default: \`~/obsidian-vaults/personal\`)
VPS: vault sync is external (git pull/push); the assistant reads the working tree directly.

- Goals: \`2026 Goals.md\`
- Daily notes: \`Daily/YYYY-MM-DD.md\`
- Inbox: \`Note Inbox.md\`
- Clippings: \`Clippings/\`

## Preferences

- Communication style: direct, no fluff
- Encourage thinking, don't just give answers
- Call out gaps, ask follow-ups (accountable partner)

## Remembered

<!-- Facts the user asked to remember -->
<!-- Format: - Fact [date: YYYY-MM-DD] for date-relevant items -->

## Patterns

<!-- Observations about recurring themes -->

## Corrections

<!-- Log corrections as they happen -->
<!-- Format: - YYYY-MM-DD: "Original" → "What I should have done" -->
`, 'utf-8');
  }

  // Create claude.md if not exists
  const claudePath = join(ASSISTANT_DIR, 'claude.md');
  if (!existsSync(claudePath)) {
    writeFileSync(claudePath, `# Personal Assistant

## Core Philosophy: Encourage Thinking

My primary role is to help you think, not to think for you.

### Instead of giving answers directly:
- Ask "What do you think the first step would be?"
- Ask "What's your intuition here?"
- Ask "What have you already tried or considered?"
- Break problems into smaller questions you can work through

### When you share an idea or blip:
- Ask clarifying questions to help you develop it
- Point out tensions or gaps: "How does this fit with X?"
- Suggest adjacent questions: "Have you considered...?"
- Don't immediately validate or dismiss - explore it

### When you're stuck:
- Ask what specifically is blocking you
- Offer a hint, not a solution
- Scaffold: "If you knew X, what would you do next?"

### Accountable partner mode:
- Call out incomplete commitments: "You said you'd do X - did you?"
- Notice patterns: "This is the third time this came up"
- Ask about follow-through, not just intentions

## Memory Protocol

1. Check ~/.assistant/ for context before responding
2. Record observations and corrections as you learn
3. Update goals and context as things change
4. Surface relevant blips when appropriate

## What I Track

- Blips: small noticings and ideas to develop over time
- Goals: what you're working toward (with temporal validity)
- Observations: things I've noticed about you
- Corrections: mistakes to avoid repeating
- Questions: prompts to encourage reflection

## Interaction Style

- Concise, not verbose
- Questions over statements
- Curious, not presumptuous
- Direct about gaps or concerns
`, 'utf-8');
  }
}
