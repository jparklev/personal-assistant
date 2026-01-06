/**
 * Git sync with Claude-based conflict resolution.
 *
 * When git pull fails due to conflicts, invokes Claude to resolve them.
 * Falls back gracefully: commits locally even if push fails.
 */

import { execSync, spawn } from 'child_process';
import { createInterface } from 'readline';

const GIT_TIMEOUT_MS = 30_000;
const CLAUDE_TIMEOUT_MS = 120_000;

interface SyncResult {
  ok: boolean;
  pushed: boolean;
  message: string;
}

/**
 * Execute git command with timeout.
 */
function git(cmd: string, cwd: string): { ok: boolean; output: string } {
  try {
    const output = execSync(`git ${cmd}`, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      stdio: 'pipe',
      encoding: 'utf-8',
    });
    return { ok: true, output: output || '' };
  } catch (err: any) {
    return { ok: false, output: err.message || String(err) };
  }
}

/**
 * Check if there are unmerged (conflicted) files.
 */
function hasConflicts(cwd: string): boolean {
  const { output } = git('diff --name-only --diff-filter=U', cwd);
  return output.trim().length > 0;
}

/**
 * Check if a merge is in progress.
 */
function isMerging(cwd: string): boolean {
  const { ok } = git('rev-parse --verify MERGE_HEAD', cwd);
  return ok;
}

/**
 * Invoke Claude to resolve git conflicts.
 */
async function resolveConflictsWithClaude(cwd: string): Promise<boolean> {
  const prompt = `You are resolving git merge conflicts in an Obsidian vault (markdown notes).

Rules:
- Do NOT lose any content.
- When in doubt, keep BOTH versions (combine sections).
- Preserve YAML frontmatter validity.
- Keep dates, names, and links exactly as written.
- Only remove conflict markers after you have merged the content.

Task:
1. Find conflicted files via \`git status\`.
2. Open each conflicted file and resolve conflicts carefully.
3. Run \`git add -A\`.
4. Complete the merge with \`git commit\` if needed.
5. Summarize what you did.`;

  return new Promise((resolve) => {
    const proc = spawn('claude', [
      '-p',
      '--dangerously-skip-permissions',
      '--output-format', 'stream-json',
    ], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    const timeout = setTimeout(() => {
      console.log('[GitSync] Claude timeout, killing process');
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), 2000);
    }, CLAUDE_TIMEOUT_MS);

    proc.stdin.write(prompt);
    proc.stdin.end();

    const rl = createInterface({ input: proc.stdout });

    rl.on('line', (line) => {
      try {
        const event = JSON.parse(line);
        if (event.type === 'assistant' && event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === 'text' && block.text) {
              console.log('[GitSync] Claude:', block.text.slice(0, 200));
            }
          }
        }
      } catch {
        // ignore parse errors
      }
    });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      console.log('[GitSync] Claude exited with code', code);

      // Check if conflicts are resolved
      const stillConflicted = hasConflicts(cwd) || isMerging(cwd);
      resolve(!stillConflicted);
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      console.error('[GitSync] Claude spawn error:', err);
      resolve(false);
    });
  });
}

/**
 * Sync vault changes to git with conflict resolution.
 *
 * Flow:
 * 1. Stage and commit local changes FIRST (so pull doesn't fail with "local changes would be overwritten")
 * 2. Pull with merge (not rebase) to get remote changes
 * 3. If conflicts, invoke Claude to resolve
 * 4. Push to remote
 *
 * Returns success even if push fails (data is safe locally).
 */
export async function syncVaultChanges(
  vaultPath: string,
  commitMessage: string
): Promise<SyncResult> {
  const tag = '[GitSync]';

  // 1. Stage and commit local changes FIRST
  // This is critical: git pull will fail with "local changes would be overwritten" if we don't commit first
  const addResult = git('add -A', vaultPath);
  if (!addResult.ok) {
    console.error(`${tag} git add failed:`, addResult.output);
    return { ok: false, pushed: false, message: 'git add failed' };
  }

  // Check if there's anything to commit
  const statusResult = git('diff --cached --quiet', vaultPath);
  const hasChanges = !statusResult.ok; // exit code 1 means there are changes

  // Commit local changes before pulling
  if (hasChanges) {
    const commitResult = git(`commit -m "${commitMessage}"`, vaultPath);
    if (!commitResult.ok && !commitResult.output.includes('nothing to commit')) {
      console.error(`${tag} Initial commit failed:`, commitResult.output);
      return { ok: false, pushed: false, message: 'commit failed' };
    }
    console.log(`${tag} Committed local changes`);
  }

  // 2. Pull to integrate remote changes (prefer merge over rebase for simpler conflict resolution)
  const pullResult = git('pull --no-rebase --no-edit', vaultPath);

  if (!pullResult.ok) {
    console.log(`${tag} Pull had issues, checking for conflicts...`);

    // Check if it's a conflict situation
    if (hasConflicts(vaultPath) || isMerging(vaultPath)) {
      console.log(`${tag} Conflicts detected, invoking Claude to resolve...`);

      const resolved = await resolveConflictsWithClaude(vaultPath);

      if (!resolved) {
        console.error(`${tag} Claude could not resolve conflicts`);
        // Local changes are already committed, so they're safe
        // Abort the merge to get back to a clean state
        git('merge --abort', vaultPath);
        return { ok: true, pushed: false, message: 'committed locally, conflicts unresolved' };
      }

      console.log(`${tag} Claude resolved conflicts successfully`);
    } else {
      // Pull failed for non-conflict reason (network, auth, etc.)
      console.error(`${tag} Pull failed (non-conflict):`, pullResult.output);
      // Local changes are already committed, so they're safe
      return { ok: true, pushed: false, message: 'committed locally, pull failed' };
    }
  }

  // 3. Push
  const pushResult = git('push', vaultPath);

  if (!pushResult.ok) {
    console.error(`${tag} Push failed:`, pushResult.output);
    return { ok: true, pushed: false, message: 'committed locally, push failed' };
  }

  console.log(`${tag} Sync complete`);
  return { ok: true, pushed: true, message: 'synced successfully' };
}
