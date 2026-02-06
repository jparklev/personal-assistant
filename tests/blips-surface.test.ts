import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';

describe('blip surfacing', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resurfaces snoozed blips when snoozed_until is invalid', () => {
    const vaultDir = mkdtempSync(join(tmpdir(), 'blips-vault-'));
    tempDirs.push(vaultDir);

    const script = [
      'import { createBlip, snoozeBlip } from "./src/blips/files";',
      'import { getBlipsToSurface } from "./src/blips/surface";',
      'const path = createBlip({ title: "Invalid Snooze Date", content: "content", now: new Date("2026-02-06T12:00:00.000Z") });',
      'snoozeBlip(path, "not-a-date");',
      'const surfaced = getBlipsToSurface(10);',
      'console.log(String(surfaced.some((s) => s.path === path)));',
    ].join('');

    const output = execFileSync('bun', ['-e', script], {
      cwd: process.cwd(),
      env: { ...process.env, OBSIDIAN_VAULT_PATH: vaultDir },
      encoding: 'utf-8',
    }).trim();

    expect(output).toBe('true');
  });
});
