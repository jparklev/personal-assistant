import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';

describe('memory filesystem line operations', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats insert line numbers as 1-based (matching view output)', () => {
    const home = mkdtempSync(join(tmpdir(), 'memory-home-'));
    tempDirs.push(home);

    const script = [
      'import { ensureMemoryDirs, create, insert, readMemory } from "./src/memory/filesystem";',
      'ensureMemoryDirs();',
      'const p = "context/notes-test.md";',
      'create(p, "one\\ntwo\\nthree");',
      'const inserted = insert(p, 2, "inserted");',
      'const content = readMemory(p);',
      'console.log(JSON.stringify({ inserted, content }));',
    ].join('');

    const raw = execFileSync('bun', ['-e', script], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    }).trim();

    const parsed = JSON.parse(raw) as { inserted: { success: boolean }; content: string };
    expect(parsed.inserted.success).toBe(true);
    expect(parsed.content).toBe(['one', 'inserted', 'two', 'three'].join('\n'));
  });
});
