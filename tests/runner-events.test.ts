import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('runner event handling', () => {
  const originalPath = process.env.PATH || '';
  const tempDirs: string[] = [];

  afterEach(() => {
    process.env.PATH = originalPath;
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('awaits async onEvent callbacks before returning', async () => {
    const binDir = mkdtempSync(join(tmpdir(), 'runner-bin-'));
    tempDirs.push(binDir);

    const claudePath = join(binDir, 'claude');
    writeFileSync(
      claudePath,
      [
        '#!/usr/bin/env bash',
        "echo '{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"sess-1\"}'",
        "echo '{\"type\":\"result\",\"subtype\":\"success\",\"session_id\":\"sess-1\",\"result\":\"ok\",\"duration_ms\":3,\"is_error\":false}'",
      ].join('\n'),
      'utf-8'
    );
    chmodSync(claudePath, 0o755);

    process.env.PATH = `${binDir}:${originalPath}`;

    const { invokeClaude } = await import('../src/assistant/runner');

    let startedHandled = false;
    const result = await invokeClaude('hello', {
      timeoutMs: 3000,
      onEvent: async (event) => {
        if (event.type === 'started') {
          await new Promise((resolve) => setTimeout(resolve, 50));
          startedHandled = true;
        }
      },
    });

    expect(result.ok).toBe(true);
    expect(startedHandled).toBe(true);
  });
});
