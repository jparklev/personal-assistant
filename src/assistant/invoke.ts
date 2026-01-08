import type { AppConfig } from '../config';
import { loadConfig } from '../config';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { formatCapturesForContext } from '../captures';
import { getBlipsToSurface } from '../blips';
import { invokeClaude } from './runner';

function safeRead(path: string, maxBytes: number): string {
  if (!existsSync(path)) return '';
  try {
    const raw = readFileSync(path);
    return raw.length > maxBytes ? raw.subarray(0, maxBytes).toString('utf-8') + '\n…' : raw.toString('utf-8');
  } catch {
    return '';
  }
}

/**
 * Build a small, low-entropy context prefix for Claude.
 *
 * This should stay stable and lightweight; Claude can Read/Glob/Grep for details.
 */
export function buildAssistantContext(opts: {
  cfg: AppConfig;
  channelMemoryPath?: string;
} | undefined = undefined): string {
  const cfg = opts?.cfg ?? loadConfig();
  const channelMemoryPath = opts?.channelMemoryPath;

  const parts: string[] = [];

  if (channelMemoryPath) {
    const mem = safeRead(channelMemoryPath, 40_000).trim();
    if (mem) parts.push(`## Channel Memory\n\n${mem}`);
  }

  // Surface a couple blips for quick situational awareness.
  try {
    const due = getBlipsToSurface(5);
    if (due.length > 0) {
      parts.push(
        [
          `## Blips (due soon)`,
          '',
          ...due.map((b) => `- ${b.title} (${b.filename}) · touched ${b.touched || 'unknown'}`),
        ].join('\n')
      );
    }
  } catch {
    // ignore
  }

  // Captures index (frontmatter only).
  try {
    parts.push(formatCapturesForContext(20));
  } catch {
    // ignore
  }

  parts.push(
    [
      `## Paths`,
      '',
      `- Blips dir: ${cfg.blipsDir}`,
      `- Vault: ${cfg.vaultPath}`,
      `- Assistant dir: ${cfg.assistantDir}`,
      `- Captures dir: ~/.assistant/captures/`,
      '',
      `Use tools (Read/Glob/Grep/git/gh) when you need details; avoid guessing.`,
    ].join('\n')
  );

  return parts.join('\n\n');
}

export function getChannelMemoryPath(cfg: AppConfig, channelId: string): string {
  return join(cfg.assistantDir, 'channels', channelId, 'memory.md');
}

// ============== Compat for scheduler tasks ==============

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
 * Backwards-compatible helper for scheduled tasks.
 * (Despite the name, it uses stream-json under the hood.)
 */
export async function invokeClaudeCode(opts: InvokeOptions): Promise<InvokeResult> {
  const cfg = loadConfig();
  const timeoutMs = opts.timeout ?? 120000;
  const cwd = opts.cwd ?? cfg.assistantDir;
  const model = opts.model ?? 'opus';

  try {
    const res = await invokeClaude(opts.prompt, { timeoutMs, model, cwd });
    return { text: (res.text || '').trim(), success: res.ok, error: res.ok ? undefined : 'Claude returned error' };
  } catch (e: any) {
    return { text: '', success: false, error: e?.message || String(e) };
  }
}
