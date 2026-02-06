import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { syncVaultChanges } from '../src/vault/git-sync';

describe('vault git sync', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not allow shell expansion from commit messages', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'vault-git-'));
    tempDirs.push(repoDir);

    execSync('git init -q', { cwd: repoDir });
    execSync('git config user.email test@example.com', { cwd: repoDir });
    execSync('git config user.name test', { cwd: repoDir });

    writeFileSync(join(repoDir, 'note.md'), 'hello\n', 'utf-8');
    execSync('git add -A && git commit -q -m init', { cwd: repoDir });

    writeFileSync(join(repoDir, 'note.md'), 'hello\nworld\n', 'utf-8');

    const marker = join(repoDir, 'injected-marker');
    const result = await syncVaultChanges(repoDir, `sync $(touch ${marker})`);

    expect(existsSync(marker)).toBe(false);
    expect(result.ok).toBe(true);
  });
});
