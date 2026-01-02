/**
 * Progress Renderer
 *
 * Tracks and renders action history for Discord progress messages.
 * Inspired by takopi's ExecProgressRenderer.
 */

import type { RunnerEvent } from './runner';

// Status symbols
const STATUS_RUNNING = '▸';
const STATUS_DONE = '✓';
const STATUS_FAIL = '✗';

interface TrackedAction {
  id: string;
  toolName: string;
  title: string;
  kind: 'command' | 'tool' | 'file_change' | 'web_search' | 'note' | 'unknown';
  status: 'running' | 'done' | 'failed';
  startTime: number;
}

export class ProgressRenderer {
  private actions: TrackedAction[] = [];
  private actionById = new Map<string, TrackedAction>();
  private maxActions: number;
  private startTime: number;
  private stepCount = 0;
  private unknownSeq = 0;

  constructor(maxActions = 5) {
    this.maxActions = maxActions;
    this.startTime = Date.now();
  }

  private nextUnknownId(): string {
    this.unknownSeq++;
    return `unknown_${this.unknownSeq}`;
  }

  private titleForEvent(event: RunnerEvent): string {
    const title = event.title || event.toolName || 'tool';
    if (event.kind === 'command') return title;
    if (event.kind === 'file_change') return `files: ${title}`;
    if (event.kind === 'web_search') return `searched: ${title}`;
    if (event.kind === 'note') return title;
    if (event.kind === 'tool') return `tool: ${title}`;
    return title;
  }

  /**
   * Process an event and update internal state.
   * Returns true if the display should be updated.
   */
  noteEvent(event: RunnerEvent): boolean {
    if (event.type === 'started') {
      this.startTime = Date.now();
      this.actions = [];
      this.actionById.clear();
      this.stepCount = 0;
      return true;
    }

    if (event.type === 'tool_start') {
      const id = event.toolId || this.nextUnknownId();
      const existing = this.actionById.get(id);
      const toolName = event.toolName || existing?.toolName || 'tool';
      const kind = event.kind || existing?.kind || 'unknown';
      const title = event.title || existing?.title || toolName;

      if (!existing || existing.status !== 'running') {
        this.stepCount++;
      }

      const action: TrackedAction = existing || {
        id,
        toolName,
        title,
        kind,
        status: 'running',
        startTime: Date.now(),
      };

      action.toolName = toolName;
      action.title = title;
      action.kind = kind;
      action.status = 'running';

      if (!existing) {
        this.actions.push(action);
        this.actionById.set(id, action);
      }

      this.trim();
      return true;
    }

    if (event.type === 'tool_end') {
      const id = event.toolId || null;

      if (id && this.actionById.has(id)) {
        const action = this.actionById.get(id)!;
        action.status = event.ok === false ? 'failed' : 'done';
        if (event.title) action.title = event.title;
        if (event.toolName) action.toolName = event.toolName;
        if (event.kind) action.kind = event.kind;
        return true;
      }

      // Fallback: mark the most recent running action as done.
      for (let i = this.actions.length - 1; i >= 0; i--) {
        const action = this.actions[i];
        if (action.status === 'running') {
          action.status = event.ok === false ? 'failed' : 'done';
          return true;
        }
      }
      return true;
    }

    if (event.type === 'text') {
      return true;
    }

    return false;
  }

  private trim(): void {
    while (this.actions.length > this.maxActions) {
      const removed = this.actions.shift();
      if (removed) this.actionById.delete(removed.id);
    }
  }

  /**
   * Format elapsed time as "Xm Ys" or "Xs".
   */
  private formatElapsed(): string {
    const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
    if (elapsed >= 60) {
      const minutes = Math.floor(elapsed / 60);
      const seconds = elapsed % 60;
      return `${minutes}m ${seconds}s`;
    }
    return `${elapsed}s`;
  }

  /**
   * Render the progress message.
   */
  render(
    currentState: 'thinking' | 'tool' | 'writing' = 'thinking',
    queueCount = 0,
    engine = 'claude',
    label?: string
  ): string {
    const elapsed = this.formatElapsed();
    const step = this.stepCount > 0 ? ` · step ${this.stepCount}` : '';

    // Header
    const stateLabel = label || (currentState === 'writing' ? 'writing' : 'working');
    const header = `${stateLabel} · ${engine} · ${elapsed}${step}`;

    // Action lines
    const actionLines: string[] = [];
    for (const action of this.actions) {
      const symbol =
        action.status === 'running'
          ? STATUS_RUNNING
          : action.status === 'done'
            ? STATUS_DONE
            : STATUS_FAIL;
      const title = this.titleForEvent({
        type: 'tool_start',
        sessionId: '',
        toolName: action.toolName,
        title: action.title,
        kind: action.kind === 'unknown' ? undefined : action.kind,
      });
      actionLines.push(`${symbol} ${title}`);
    }

    // Add current state indicator if no running actions
    const hasRunning = this.actions.some((a) => a.status === 'running');
    if (!hasRunning) {
      if (currentState === 'thinking') {
        actionLines.push(`${STATUS_RUNNING} Thinking...`);
      } else if (currentState === 'writing') {
        actionLines.push(`${STATUS_RUNNING} Writing...`);
      }
    }

    if (actionLines.length === 0) {
      return queueCount > 0 ? `${header}\n\nqueue: ${queueCount}` : header;
    }

    const body = `${header}\n\n${actionLines.join('\n')}`;
    return queueCount > 0 ? `${body}\n\nqueue: ${queueCount}` : body;
  }

  /**
   * Render final status.
   */
  renderFinal(
    ok: boolean,
    engine = 'claude',
    statusOverride?: 'done' | 'error' | 'cancelled'
  ): string {
    const elapsed = this.formatElapsed();
    const step = this.stepCount > 0 ? ` · step ${this.stepCount}` : '';
    const status = statusOverride || (ok ? 'done' : 'error');
    return `${status} · ${engine} · ${elapsed}${step}`;
  }

  /**
   * Get list of tools used.
   */
  getToolsUsed(): string[] {
    const seen = new Set<string>();
    for (const action of this.actions) {
      seen.add(action.toolName);
    }
    return Array.from(seen);
  }
}
