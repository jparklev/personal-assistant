import { spawn, type ChildProcess } from 'child_process';
import { createInterface } from 'readline';

let running: ChildProcess | null = null;
let pending: { vaultPath: string; commitMessage: string } | null = null;

function pipeLines(stream: NodeJS.ReadableStream | null, prefix: string): void {
  if (!stream) return;
  const rl = createInterface({ input: stream });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    console.log(prefix, line);
  });
}

function start(vaultPath: string, commitMessage: string): void {
  const runtime = process.execPath.includes('bun') ? process.execPath : 'bun';
  const args = ['run', 'src/vault/sync-vault-child.ts', vaultPath, commitMessage];

  const child = spawn(runtime, args, {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  running = child;
  console.log('[VaultSync] Started', { pid: child.pid, commitMessage });

  pipeLines(child.stdout, '[VaultSync][stdout]');
  pipeLines(child.stderr, '[VaultSync][stderr]');

  child.on('close', (code) => {
    console.log('[VaultSync] Exited', { pid: child.pid, code });
    running = null;

    const next = pending;
    pending = null;
    if (next) start(next.vaultPath, next.commitMessage);
  });

  child.on('error', (err) => {
    console.error('[VaultSync] Spawn error:', err);
    if (running === child) running = null;
  });
}

export function requestVaultSync(
  vaultPath: string,
  commitMessage: string
): { started: boolean; queued: boolean } {
  if (running) {
    pending = { vaultPath, commitMessage };
    return { started: false, queued: true };
  }

  start(vaultPath, commitMessage);
  return { started: true, queued: false };
}
