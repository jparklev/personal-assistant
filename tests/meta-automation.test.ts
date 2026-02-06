import { afterEach, describe, expect, it } from 'bun:test';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  findNewDirtyFiles,
  formatMetaAutomationSummary,
  listDirtyFiles,
} from '../src/meta/automation';

describe('meta automation helpers', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tracks new dirty files relative to a baseline', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'meta-auto-'));
    tempDirs.push(repoDir);

    execSync('git init -q', { cwd: repoDir });
    execSync('git config user.email test@example.com', { cwd: repoDir });
    execSync('git config user.name test', { cwd: repoDir });
    writeFileSync(join(repoDir, 'a.txt'), 'one\n', 'utf-8');
    execSync('git add -A && git commit -q -m init', { cwd: repoDir });

    const baseline = listDirtyFiles(repoDir);
    expect(baseline.length).toBe(0);

    writeFileSync(join(repoDir, 'a.txt'), 'one\ntwo\n', 'utf-8');
    writeFileSync(join(repoDir, 'b.txt'), 'new\n', 'utf-8');

    const delta = findNewDirtyFiles(repoDir, baseline).sort();
    expect(delta).toEqual(['a.txt', 'b.txt']);
  });

  it('formats a compact gate summary', () => {
    const summary = formatMetaAutomationSummary({
      changedFiles: ['x.ts'],
      validation: {
        ok: false,
        steps: [
          { name: 'tests', command: 'bun test tests', ok: false, output: 'failed' },
        ],
      },
      committed: false,
      pushed: false,
      message: 'Validation failed at tests.',
    });

    expect(summary).toContain('**Meta Gate**');
    expect(summary).toContain('validation: failed');
    expect(summary).toContain('failed step: tests');
  });
});
