/**
 * Stateless Claude Runner
 *
 * Runs Claude CLI in print mode with stream-json output.
 * Each invocation is independent - state persisted via resume tokens.
 * Per-session serialization prevents concurrent runs on the same session.
 */

import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { join } from 'path';
import { homedir } from 'os';

const ASSISTANT_DIR = join(homedir(), '.assistant');

// Per-session locks to prevent concurrent runs on the same session
const sessionLocks = new Map<string, Promise<void>>();
const sessionResolvers = new Map<string, () => void>();

async function acquireSessionLock(sessionId: string): Promise<void> {
  // Wait for any existing lock on this session
  while (sessionLocks.has(sessionId)) {
    await sessionLocks.get(sessionId);
  }

  // Create a new lock
  let resolver: () => void;
  const lock = new Promise<void>((resolve) => {
    resolver = resolve;
  });
  sessionLocks.set(sessionId, lock);
  sessionResolvers.set(sessionId, resolver!);
}

function releaseSessionLock(sessionId: string): void {
  const resolver = sessionResolvers.get(sessionId);
  if (resolver) {
    sessionLocks.delete(sessionId);
    sessionResolvers.delete(sessionId);
    resolver();
  }
}

// Event types from Claude stream-json output
export interface ClaudeInitEvent {
  type: 'system';
  subtype: 'init';
  session_id: string;
  model?: string;
  tools?: string[];
}

export interface ClaudeAssistantEvent {
  type: 'assistant';
  session_id: string;
  message: {
    id?: string;
    content: Array<
      | { type: 'text'; text: string }
      | { type: 'tool_use'; id: string; name: string; input: unknown }
    >;
  };
  parent_tool_use_id?: string;
}

export interface ClaudeUserEvent {
  type: 'user';
  session_id: string;
  // Older/alternate stream formats sometimes include this.
  tool_use_result?: string;
  message?: {
    id?: string;
    content?: Array<
      | {
          type: 'tool_result';
          tool_use_id: string;
          content?: unknown;
          is_error?: boolean;
        }
      | { type: 'text'; text: string }
    >;
  };
}

export interface ClaudeResultEvent {
  type: 'result';
  subtype: 'success' | 'error';
  session_id: string;
  result: string;
  duration_ms: number;
  is_error: boolean;
}

export type ClaudeEvent =
  | ClaudeInitEvent
  | ClaudeAssistantEvent
  | ClaudeUserEvent
  | ClaudeResultEvent;

// Normalized events for our renderer
export interface RunnerEvent {
  type: 'started' | 'text' | 'tool_start' | 'tool_end' | 'completed';
  sessionId: string;
  content?: string;
  toolId?: string;
  toolName?: string;
  title?: string;
  kind?: 'command' | 'tool' | 'file_change' | 'web_search' | 'note';
  ok?: boolean;
  durationMs?: number;
}

export interface RunResult {
  sessionId: string;
  text: string;
  durationMs: number;
  ok: boolean;
  toolsUsed: string[];
}

function stripAnthropicApiKeyEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  return env;
}

function summarizeToolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item === 'string') parts.push(item);
      else if (item && typeof item === 'object' && typeof (item as any).text === 'string') parts.push((item as any).text);
    }
    return parts.join('\n');
  }
  if (content == null) return '';
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function toolDisplayFromUse(toolName: string, toolInput: unknown): { kind: RunnerEvent['kind']; title: string } {
  const input = toolInput && typeof toolInput === 'object' ? (toolInput as Record<string, unknown>) : {};
  const path = (typeof input.file_path === 'string' && input.file_path) || (typeof input.path === 'string' && input.path) || null;

  if (toolName === 'Bash' || toolName === 'Shell' || toolName === 'KillShell') {
    const cmd = typeof input.command === 'string' ? input.command : toolName;
    return { kind: 'command', title: cmd };
  }
  if (toolName === 'Read') {
    return { kind: 'tool', title: path ? `read: ${path}` : 'read' };
  }
  if (toolName === 'Glob') {
    const pattern = typeof input.pattern === 'string' ? input.pattern : null;
    return { kind: 'tool', title: pattern ? `glob: ${pattern}` : 'glob' };
  }
  if (toolName === 'Grep') {
    const pattern = typeof input.pattern === 'string' ? input.pattern : null;
    return { kind: 'tool', title: pattern ? `grep: ${pattern}` : 'grep' };
  }
  if (toolName === 'WebSearch' || toolName === 'WebFetch') {
    const q = typeof input.query === 'string' ? input.query : null;
    const url = typeof input.url === 'string' ? input.url : null;
    return { kind: 'web_search', title: q || url || toolName };
  }
  if (toolName === 'Edit' || toolName === 'Write' || toolName === 'NotebookEdit' || toolName === 'MultiEdit') {
    return { kind: 'file_change', title: path || toolName };
  }
  if (toolName === 'TodoWrite' || toolName === 'TodoRead') {
    return { kind: 'note', title: toolName === 'TodoWrite' ? 'update todos' : 'read todos' };
  }
  if (toolName === 'AskUserQuestion') {
    return { kind: 'note', title: 'ask user' };
  }

  return { kind: 'tool', title: toolName };
}

function terminateProcess(proc: ReturnType<typeof spawn>): void {
  if (!proc.pid) return;
  try {
    if (process.platform !== 'win32') {
      process.kill(-proc.pid, 'SIGTERM');
      return;
    }
  } catch {
    // fall through
  }
  try {
    proc.kill('SIGTERM');
  } catch {
    // ignore
  }
}

function killProcess(proc: ReturnType<typeof spawn>): void {
  if (!proc.pid) return;
  try {
    if (process.platform !== 'win32') {
      process.kill(-proc.pid, 'SIGKILL');
      return;
    }
  } catch {
    // fall through
  }
  try {
    proc.kill('SIGKILL');
  } catch {
    // ignore
  }
}

/**
 * Run Claude CLI with streaming JSON output.
 * Returns an async generator of events and the final result.
 * Per-session serialization ensures only one run per session at a time.
 */
export async function* runClaude(
  prompt: string,
  options: {
    resumeId?: string;
    model?: string;
    timeoutMs?: number;
    cwd?: string;
    signal?: AbortSignal;
    onEvent?: (event: RunnerEvent) => void;
  } = {}
): AsyncGenerator<RunnerEvent, RunResult> {
  // Acquire lock if resuming an existing session
  if (options.resumeId) {
    await acquireSessionLock(options.resumeId);
  }

  let acquiredSessionId: string | null = options.resumeId || null;

  try {
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
    ];

    if (options.model) {
      args.push('--model', options.model);
    } else {
      args.push('--model', 'opus');
    }

    if (options.resumeId) {
      args.push('--resume', options.resumeId);
    }

    const proc = spawn('claude', args, {
      cwd: options.cwd || ASSISTANT_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      env: stripAnthropicApiKeyEnv(),
    });

    const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
    let didTimeout = false;
    let didAbort = false;
    const timeout = setTimeout(() => {
      didTimeout = true;
      terminateProcess(proc);
      setTimeout(() => killProcess(proc), 2000);
    }, timeoutMs);

    const onAbort = () => {
      didAbort = true;
      terminateProcess(proc);
      setTimeout(() => killProcess(proc), 2000);
    };

    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }

    // Send prompt to stdin (safer than argv length limits)
    proc.stdin.write(prompt);
    proc.stdin.end();

    const rl = createInterface({ input: proc.stdout });

    let sessionId = '';
    let finalResult = '';
    let durationMs = 0;
    let ok = true;
    let sawResult = false;
    const toolsUsed: string[] = [];
    const seenToolUseIds = new Set<string>();
    const pendingToolTitles = new Map<string, { toolName: string; title: string; kind: RunnerEvent['kind'] }>();

    for await (const line of rl) {
      if (!line.trim()) continue;

      let event: ClaudeEvent;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }

      if (event.type === 'system' && (event as ClaudeInitEvent).subtype === 'init') {
        const init = event as ClaudeInitEvent;
        sessionId = init.session_id;

        // For new sessions, acquire lock now that we know the session ID
        if (!options.resumeId) {
          await acquireSessionLock(sessionId);
          acquiredSessionId = sessionId;
        }

        const startedEvent: RunnerEvent = {
          type: 'started',
          sessionId,
        };
        options.onEvent?.(startedEvent);
        yield startedEvent;
      } else if (event.type === 'assistant') {
        const assistant = event as ClaudeAssistantEvent;
        for (const content of assistant.message.content) {
          if (content.type === 'text' && content.text) {
            const textEvent: RunnerEvent = {
              type: 'text',
              sessionId,
              content: content.text,
            };
            options.onEvent?.(textEvent);
            yield textEvent;
          } else if (content.type === 'tool_use') {
            if (!content.id) continue;

            if (!seenToolUseIds.has(content.id)) {
              seenToolUseIds.add(content.id);
              if (content.name && !toolsUsed.includes(content.name)) toolsUsed.push(content.name);
            }

            const { kind, title } = toolDisplayFromUse(content.name, content.input);
            pendingToolTitles.set(content.id, { toolName: content.name, title, kind });

            const toolEvent: RunnerEvent = {
              type: 'tool_start',
              sessionId,
              toolId: content.id,
              toolName: content.name,
              title,
              kind,
            };
            options.onEvent?.(toolEvent);
            yield toolEvent;
          }
        }
      } else if (event.type === 'user') {
        const user = event as ClaudeUserEvent;

        // Older format: no tool_use_id available; treat as a generic tool end.
        if (typeof user.tool_use_result === 'string' && user.tool_use_result) {
          const toolEndEvent: RunnerEvent = {
            type: 'tool_end',
            sessionId,
            content: user.tool_use_result,
          };
          options.onEvent?.(toolEndEvent);
          yield toolEndEvent;
          continue;
        }

        const blocks = user.message?.content;
        if (!Array.isArray(blocks)) continue;

        for (const block of blocks) {
          if (!block || typeof block !== 'object') continue;
          if ((block as any).type !== 'tool_result') continue;

          const toolUseId = (block as any).tool_use_id;
          if (typeof toolUseId !== 'string' || !toolUseId) continue;

          const isError = (block as any).is_error === true;
          const resultText = summarizeToolResultText((block as any).content);
          const pending = pendingToolTitles.get(toolUseId);

          const toolEndEvent: RunnerEvent = {
            type: 'tool_end',
            sessionId,
            toolId: toolUseId,
            toolName: pending?.toolName,
            title: pending?.title,
            kind: pending?.kind,
            ok: !isError,
            content: resultText,
          };
          options.onEvent?.(toolEndEvent);
          yield toolEndEvent;
        }
      } else if (event.type === 'result') {
        const result = event as ClaudeResultEvent;
        finalResult = result.result;
        durationMs = result.duration_ms;
        ok = !result.is_error;
        sawResult = true;
        const completedEvent: RunnerEvent = {
          type: 'completed',
          sessionId: result.session_id,
          content: result.result,
          ok,
          durationMs,
        };
        options.onEvent?.(completedEvent);
        yield completedEvent;
      }
    }

    // Wait for process to exit
    await new Promise<void>((resolve) => {
      proc.on('close', () => resolve());
    });

    if (options.signal) {
      options.signal.removeEventListener('abort', onAbort);
    }
    clearTimeout(timeout);

    if (!sawResult) {
      ok = false;
      if (didAbort) finalResult = 'Cancelled.';
      else if (didTimeout) finalResult = 'Timeout exceeded.';
      else finalResult = finalResult || 'Claude exited without a result.';
    }

    return {
      sessionId,
      text: finalResult,
      durationMs,
      ok,
      toolsUsed,
    };
  } finally {
    // Release session lock
    if (acquiredSessionId) {
      releaseSessionLock(acquiredSessionId);
    }
  }
}

/**
 * Simple helper to run Claude and get the result.
 */
export async function invokeClaude(
  prompt: string,
  options: {
    resumeId?: string;
    model?: string;
    timeoutMs?: number;
    cwd?: string;
    signal?: AbortSignal;
    onEvent?: (event: RunnerEvent) => void;
  } = {}
): Promise<RunResult> {
  const generator = runClaude(prompt, options);
  let result: IteratorResult<RunnerEvent, RunResult>;
  do {
    result = await generator.next();
  } while (!result.done);
  return result.value;
}

/**
 * Format a resume token for embedding in messages.
 */
export function formatResumeToken(sessionId: string): string {
  return `\`claude --resume ${sessionId}\``;
}

/**
 * Extract a resume token from message text.
 */
export function extractResumeToken(text: string): string | null {
  const match = text.match(/`?claude\s+(?:--resume|-r)\s+([^`\s]+)`?/i);
  return match ? match[1] : null;
}
