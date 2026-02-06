import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('blips stream state selection', () => {
  const originalVault = process.env.OBSIDIAN_VAULT_PATH;
  const tempDirs: string[] = [];

  afterEach(() => {
    if (originalVault == null) {
      delete process.env.OBSIDIAN_VAULT_PATH;
    } else {
      process.env.OBSIDIAN_VAULT_PATH = originalVault;
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not keep a non-surfaceable current filename pinned', async () => {
    const vaultDir = mkdtempSync(join(tmpdir(), 'stream-vault-'));
    tempDirs.push(vaultDir);
    process.env.OBSIDIAN_VAULT_PATH = vaultDir;

    const blips = await import(`../src/blips/files.ts?streamFiles=${Date.now()}`);
    const stream = await import(`../src/discord/blips-stream.ts?stream=${Date.now()}`);

    const archivedPath = blips.createBlip({
      title: 'Archived',
      content: 'a',
      now: new Date('2026-02-06T12:00:00.000Z'),
    });
    const activePath = blips.createBlip({
      title: 'Active',
      content: 'b',
      now: new Date('2026-02-06T12:00:00.000Z'),
    });
    blips.archiveBlip(archivedPath);

    const archivedFile = archivedPath.split('/').pop()!;
    const activeFile = activePath.split('/').pop()!;

    const picked = stream.pickCurrentOrNextFilename(archivedFile, activeFile);
    expect(picked).toBe(activeFile);
  });
});
