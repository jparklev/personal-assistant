/**
 * Invoke Claude Code for assistant tasks.
 *
 * This runs Claude Code in --print mode with a prompt,
 * letting it read ~/.assistant/ context and respond.
 */

import { spawn } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { getFileBlipStore } from '../blips/file-store';
import { VaultWatcher } from '../vault/watcher';
import { parseFrontmatter, serializeFrontmatter } from '../utils/frontmatter';
import { getTodayReminders, formatRemindersForContext } from '../integrations/reminders';

const ASSISTANT_DIR = join(homedir(), '.assistant');

export interface InvokeOptions {
  prompt: string;
  cwd?: string;
  timeout?: number; // ms, default 120000
  model?: string; // default 'opus'
}

export interface InvokeResult {
  text: string;
  success: boolean;
  error?: string;
}

/**
 * Invoke Claude Code with a prompt and get the response.
 * Uses --print mode for non-interactive execution.
 */
export async function invokeClaudeCode(opts: InvokeOptions): Promise<InvokeResult> {
  const { prompt, cwd = ASSISTANT_DIR, timeout = 120000, model = 'opus' } = opts;

  const args = [
    '--print',
    '--model', model,
    '--dangerously-skip-permissions',
    prompt,
  ];

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let killed = false;

    const proc = spawn('claude', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGTERM');
    }, timeout);

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(timer);

      if (killed) {
        resolve({
          text: stdout,
          success: false,
          error: 'Timeout exceeded',
        });
      } else if (code !== 0) {
        resolve({
          text: stdout,
          success: false,
          error: stderr || `Exit code ${code}`,
        });
      } else {
        resolve({
          text: stdout.trim(),
          success: true,
        });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        text: '',
        success: false,
        error: err.message,
      });
    });
  });
}

// Vault path - configurable via OBSIDIAN_VAULT_PATH env var
export const VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH?.trim() ||
  join(homedir(), 'Library/Mobile Documents/iCloud~md~Obsidian/Documents/Personal');

/**
 * Build context from ~/.assistant/ for injection into prompts.
 * Uses progressive disclosure:
 * - Memory (pointers + learnings)
 * - Vault changes since last check (git diff)
 * - Blips INDEX only (lightweight)
 * - Reminders (if any due today)
 */
export function buildAssistantContext(): string {
  const lines: string[] = [];
  const memoryPath = join(ASSISTANT_DIR, 'memory.md');

  // Memory file (pointers + learnings)
  let lastVaultCommit: string | null = null;
  if (existsSync(memoryPath)) {
    const raw = readFileSync(memoryPath, 'utf-8');
    const { frontmatter } = parseFrontmatter<{ last_vault_commit?: string }>(raw);
    lastVaultCommit = frontmatter?.last_vault_commit ?? null;

    // Include full memory (it's meant to stay small)
    lines.push(`## Memory\n\n${raw}\n`);
  }

  // Vault changes since last check
  const watcher = new VaultWatcher(VAULT_PATH);
  if (watcher.hasGit()) {
    const currentCommit = watcher.getCurrentCommit();

    if (lastVaultCommit && lastVaultCommit !== 'null') {
      const changes = watcher.getChangesSince(lastVaultCommit);
      if (changes.length > 0) {
        lines.push(`## Recent Vault Changes (since last check)\n`);
        for (const change of changes.slice(0, 20)) {
          lines.push(`- ${change.type}: ${change.path}`);
        }
        if (changes.length > 20) {
          lines.push(`- ... and ${changes.length - 20} more`);
        }
        lines.push('');
      }
    } else {
      // First run or no previous commit - show today's changes
      const todayChanges = watcher.getChangesToday();
      if (todayChanges.length > 0) {
        lines.push(`## Today's Vault Changes\n`);
        for (const change of todayChanges.slice(0, 10)) {
          lines.push(`- ${change.type}: ${change.path}`);
        }
        lines.push('');
      }
    }
  }

  // Blips INDEX only - not full content
  try {
    const blipStore = getFileBlipStore();
    const blipsIndex = blipStore.formatIndexForContext(50);
    lines.push(`${blipsIndex}\n`);
  } catch {
    // Store may not be initialized yet
  }

  // Apple Reminders due today
  try {
    const reminders = getTodayReminders();
    if (reminders.length > 0) {
      lines.push(formatRemindersForContext(reminders));
      lines.push('');
    }
  } catch {
    // Reminders not available
  }

  // Captures location (pointer only)
  lines.push(`## Captures

Location: ~/.assistant/captures/
Use Read tool to access specific captures.
`);

  return lines.join('\n');
}

/**
 * Update last_vault_commit in memory.md after processing
 */
export function checkpointVaultCommit(): void {
  const memoryPath = join(ASSISTANT_DIR, 'memory.md');
  if (!existsSync(memoryPath)) return;

  const watcher = new VaultWatcher(VAULT_PATH);
  if (!watcher.hasGit()) return;

  const currentCommit = watcher.getCurrentCommit();
  if (!currentCommit) return;

  const raw = readFileSync(memoryPath, 'utf-8');
  const { frontmatter, content } = parseFrontmatter<{ updated?: string; last_vault_commit?: string }>(raw);

  const newFrontmatter = {
    ...frontmatter,
    updated: new Date().toISOString().split('T')[0],
    last_vault_commit: currentCommit,
  };

  writeFileSync(memoryPath, serializeFrontmatter(newFrontmatter, content), 'utf-8');
}
