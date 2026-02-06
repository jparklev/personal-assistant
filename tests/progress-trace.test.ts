import { describe, expect, it } from 'bun:test';
import { ProgressRenderer } from '../src/assistant/progress';

describe('progress trace UX', () => {
  it('includes an always-on compact trace line', () => {
    const renderer = new ProgressRenderer();
    renderer.noteEvent({ type: 'started', sessionId: 's1' });
    renderer.noteEvent({
      type: 'tool_start',
      sessionId: 's1',
      toolId: 't1',
      toolName: 'Read',
      title: 'read: src/index.ts',
      kind: 'tool',
    });
    renderer.noteEvent({
      type: 'tool_start',
      sessionId: 's1',
      toolId: 't2',
      toolName: 'Edit',
      title: 'src/index.ts',
      kind: 'file_change',
    });
    renderer.noteEvent({
      type: 'tool_start',
      sessionId: 's1',
      toolId: 't3',
      toolName: 'Bash',
      title: 'bun run typecheck',
      kind: 'command',
    });

    const rendered = renderer.render('tool', 0, 'claude');
    expect(rendered).toContain('trace:');
    expect(rendered).toContain('inspect');
    expect(rendered).toContain('patch');
    expect(rendered).toContain('validate');
  });
});
