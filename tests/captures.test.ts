import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('captures storage', () => {
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

  it('disambiguates same-day same-title captures', async () => {
    const vaultDir = mkdtempSync(join(tmpdir(), 'captures-vault-'));
    tempDirs.push(vaultDir);
    process.env.OBSIDIAN_VAULT_PATH = vaultDir;

    const mod = await import(`../src/captures/index.ts?case=${Date.now()}`);
    const meta = {
      title: 'My Capture',
      url: 'https://example.com/post',
      type: 'article' as const,
      capturedAt: '2026-02-06T10:00:00.000Z',
    };

    const first = mod.saveCapture(meta, 'one', { now: new Date('2026-02-06T10:00:00.000Z') });
    const second = mod.saveCapture(meta, 'two', { now: new Date('2026-02-06T10:01:00.000Z') });

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(second.filePath).not.toBe(first.filePath);
  });

  it('escapes URL safely in YAML frontmatter', async () => {
    const mod = await import(`../src/captures/index.ts?yaml=${Date.now()}`);
    const fm = mod.generateFrontmatter({
      title: 'Title',
      url: 'https://example.com?q="quoted"&x=1',
      type: 'article',
      capturedAt: '2026-02-06T10:00:00.000Z',
    });

    expect(fm).toContain('url: "https://example.com?q=\\"quoted\\"&x=1"');
  });
});
