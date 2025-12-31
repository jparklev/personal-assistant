/**
 * Claude Code Session for Personal Assistant
 *
 * A persistent Claude Code session that supports streaming output.
 * Uses tmux for interactive sessions with incremental output capture.
 */

import { execFileSync } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';

const POLL_INTERVAL_MS = 300;
const RESPONSE_TIMEOUT_MS = 180_000; // 3 minutes for captures
const IDLE_THRESHOLD_MS = 5_000;

const ASSISTANT_DIR = join(homedir(), '.assistant');
const SESSION_NAME = 'personal-assistant';

function stripAnsi(str: string): string {
  return str
    .replace(/\x1B\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1B\][^\x07]*\x07/g, '')
    .replace(/[\x00-\x1F]/g, (c) => (c === '\n' ? '\n' : ''));
}

function tmux(args: string[], opts?: { allowFailure?: boolean }): string {
  try {
    return execFileSync('tmux', args, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e: any) {
    if (!opts?.allowFailure) throw e;
    return (e?.stdout as string | undefined) || '';
  }
}

function tmuxOk(args: string[]): boolean {
  try {
    execFileSync('tmux', args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export interface StreamUpdate {
  type: 'thinking' | 'tool' | 'response' | 'progress';
  content: string;
  isComplete: boolean;
}

export interface SessionResult {
  text: string;
  durationMs: number;
  toolCalls: string[];
}

/**
 * Singleton Claude Code session for the personal assistant.
 */
class ClaudeSession {
  private running = false;
  private model = 'opus';

  hasSession(): boolean {
    return tmuxOk(['has-session', '-t', SESSION_NAME]);
  }

  get isRunning(): boolean {
    return this.running && this.hasSession();
  }

  async ensureRunning(): Promise<void> {
    if (this.isRunning) return;

    if (this.hasSession()) {
      this.running = true;
      return;
    }

    await this.start();
  }

  private async start(): Promise<void> {
    // Kill any existing session
    tmux(['kill-session', '-t', SESSION_NAME], { allowFailure: true });

    // Secrets to unset
    const secretsToUnset = [
      'DISCORD_BOT_TOKEN',
      'DISCORD_APP_ID',
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'GOOGLE_API_KEY',
      'GEMINI_API_KEY',
      'GITHUB_TOKEN',
      'GH_TOKEN',
    ];

    const envUnsetArgs = secretsToUnset.flatMap((key) => ['-u', key]);

    const args = [
      'new-session',
      '-d',
      '-s',
      SESSION_NAME,
      '-x',
      '200',
      '-y',
      '50',
      '-c',
      ASSISTANT_DIR,
      'env',
      ...envUnsetArgs,
      'claude',
      '--dangerously-skip-permissions',
      '--model',
      this.model,
    ];

    tmux(args);
    this.running = true;
    await this.waitForReady();
  }

  kill(): void {
    tmux(['kill-session', '-t', SESSION_NAME], { allowFailure: true });
    this.running = false;
  }

  private capturePane(): string {
    return stripAnsi(tmux(['capture-pane', '-t', SESSION_NAME, '-p', '-J', '-S', '-2000']));
  }

  private sendKeys(message: string): void {
    execFileSync('tmux', ['send-keys', '-t', SESSION_NAME, '-l', message], {
      stdio: 'ignore',
    });
    execFileSync('tmux', ['send-keys', '-t', SESSION_NAME, 'Enter'], { stdio: 'ignore' });
  }

  private async waitForReady(): Promise<void> {
    const startTime = Date.now();
    while (Date.now() - startTime < 30_000) {
      await new Promise((r) => setTimeout(r, 1_000));
      const output = this.capturePane();
      if (
        output.includes('What would you like to do?') ||
        output.includes('Claude Code') ||
        output.includes('tokens') ||
        output.includes('>')
      ) {
        return;
      }
    }
    throw new Error('Timeout waiting for Claude to initialize');
  }

  /**
   * Send a prompt and stream updates via callback.
   */
  async sendWithStreaming(
    prompt: string,
    onUpdate: (update: StreamUpdate) => Promise<void>
  ): Promise<SessionResult> {
    await this.ensureRunning();

    const initialOutput = this.capturePane();
    const initialMarkerCount = (initialOutput.match(/⏺/g) || []).length;

    this.sendKeys(prompt);

    const startTime = Date.now();
    let lastOutput = '';
    let lastChangeTime = Date.now();
    let lastUpdateContent = '';
    let responseDetected = false;
    const toolCalls: string[] = [];

    while (Date.now() - startTime < RESPONSE_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const currentOutput = this.capturePane();
      const currentMarkerCount = (currentOutput.match(/⏺/g) || []).length;

      if (!responseDetected && currentMarkerCount > initialMarkerCount) {
        responseDetected = true;
      }

      // Check for changes and send updates
      if (currentOutput !== lastOutput) {
        lastOutput = currentOutput;
        lastChangeTime = Date.now();

        // Extract current state for streaming
        const update = this.extractStreamingUpdate(currentOutput, initialMarkerCount, lastUpdateContent);
        if (update && update.content !== lastUpdateContent) {
          lastUpdateContent = update.content;

          // Track tool calls
          if (update.type === 'tool') {
            const toolMatch = update.content.match(/^([A-Z][a-z]+(?:[A-Z][a-z]+)*)/);
            if (toolMatch && !toolCalls.includes(toolMatch[1])) {
              toolCalls.push(toolMatch[1]);
            }
          }

          try {
            await onUpdate(update);
          } catch {
            // Ignore update errors
          }
        }
        continue;
      }

      if (responseDetected && Date.now() - lastChangeTime > IDLE_THRESHOLD_MS) {
        break;
      }
    }

    // Final update
    const finalText = this.extractAllResponses(lastOutput, initialMarkerCount);
    try {
      await onUpdate({
        type: 'response',
        content: finalText,
        isComplete: true,
      });
    } catch {
      // Ignore
    }

    return {
      text: finalText,
      durationMs: Date.now() - startTime,
      toolCalls,
    };
  }

  /**
   * Extract current streaming state for updates.
   */
  private extractStreamingUpdate(
    fullOutput: string,
    initialMarkerCount: number,
    lastContent: string
  ): StreamUpdate | null {
    const lines = fullOutput.split('\n');

    // Check for thinking
    const thinkingIdx = this.findLastIndex(lines, (l) =>
      l.includes('∴ Thinking') || l.includes('Thinking…') || l.includes('Thinking...')
    );

    // Check for tool use (lines starting with tool indicators)
    const toolIdx = this.findLastIndex(lines, (l) =>
      l.includes('⏺') && (
        l.includes('Read') ||
        l.includes('Write') ||
        l.includes('Edit') ||
        l.includes('Bash') ||
        l.includes('Glob') ||
        l.includes('Grep') ||
        l.includes('WebFetch') ||
        l.includes('Task')
      )
    );

    // Check for response markers
    const responseIdx = this.findLastIndex(lines, (l) => l.includes('⏺'));

    // Determine what to show
    if (thinkingIdx > responseIdx && thinkingIdx > toolIdx) {
      // Currently thinking
      const thinking = this.extractThinkingAt(lines, thinkingIdx);
      return {
        type: 'thinking',
        content: thinking.slice(0, 500),
        isComplete: false,
      };
    }

    if (toolIdx >= 0) {
      // Tool in progress
      const toolLine = lines[toolIdx].replace(/.*⏺\s*/, '').trim();
      return {
        type: 'tool',
        content: toolLine,
        isComplete: false,
      };
    }

    if (responseIdx >= 0) {
      // Response in progress
      const response = this.extractResponseAt(lines, responseIdx);
      return {
        type: 'response',
        content: response.slice(0, 1000),
        isComplete: false,
      };
    }

    return null;
  }

  private findLastIndex(arr: string[], pred: (s: string) => boolean): number {
    for (let i = arr.length - 1; i >= 0; i--) {
      if (pred(arr[i])) return i;
    }
    return -1;
  }

  private extractThinkingAt(lines: string[], start: number): string {
    const result: string[] = [];
    for (let i = start; i < lines.length; i++) {
      const l = lines[i];
      if (l.includes('⏺')) break;
      if (l.startsWith('>')) break;
      result.push(l.trim());
    }
    return result.join('\n').trim();
  }

  private extractResponseAt(lines: string[], markerLine: number): string {
    const responseLines: string[] = [];
    const firstLine = lines[markerLine].replace(/.*⏺\s*/, '').trim();
    if (firstLine) responseLines.push(firstLine);

    for (let i = markerLine + 1; i < lines.length; i++) {
      const line = lines[i];
      const t = line.trim();
      if (t === '>') break;
      if (line.includes('────')) break;
      if (line.includes('│') && line.includes('tokens')) break;
      if (line.includes('⏺')) break;
      const trimmed = line.trim();
      if (trimmed) responseLines.push(trimmed);
    }

    return responseLines.join('\n');
  }

  private extractAllResponses(fullOutput: string, startAfter: number): string {
    const lines = fullOutput.split('\n');
    const markerLines: number[] = [];

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('⏺')) {
        markerLines.push(i);
      }
    }

    const newMarkerLines = markerLines.slice(startAfter);
    if (newMarkerLines.length === 0) return '';

    const responses: string[] = [];
    for (const markerLine of newMarkerLines) {
      const response = this.extractResponseAt(lines, markerLine);
      if (response.trim()) {
        responses.push(response);
      }
    }

    return responses.join('\n\n');
  }

  async compact(instructions?: string): Promise<void> {
    await this.ensureRunning();
    const cmd = instructions ? `/compact ${instructions}` : '/compact';
    this.sendKeys(cmd);
    await new Promise((r) => setTimeout(r, 3_000));
  }

  getStatus(): { running: boolean; session: string } {
    return {
      running: this.isRunning,
      session: SESSION_NAME,
    };
  }
}

// Singleton instance
let sessionInstance: ClaudeSession | null = null;

export function getClaudeSession(): ClaudeSession {
  if (!sessionInstance) {
    sessionInstance = new ClaudeSession();
  }
  return sessionInstance;
}
