import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import type { VaultChange } from './types';

export class VaultWatcher {
  constructor(private vaultPath: string) {}

  // Check if the vault has a git repo
  hasGit(): boolean {
    return existsSync(join(this.vaultPath, '.git'));
  }

  // Get the current HEAD commit hash
  getCurrentCommit(): string | null {
    if (!this.hasGit()) return null;

    try {
      const result = execSync('git rev-parse HEAD', {
        cwd: this.vaultPath,
        encoding: 'utf-8',
      });
      return result.trim();
    } catch {
      return null;
    }
  }

  // Get changes since a specific commit
  getChangesSince(commitHash: string): VaultChange[] {
    if (!this.hasGit()) return [];

    try {
      const result = execSync(`git diff ${commitHash}..HEAD --name-status`, {
        cwd: this.vaultPath,
        encoding: 'utf-8',
      });

      return this.parseGitDiff(result);
    } catch {
      return [];
    }
  }

  // Get recent commits (for context)
  getRecentCommits(count: number = 10): { hash: string; message: string; date: string }[] {
    if (!this.hasGit()) return [];

    try {
      const result = execSync(`git log -${count} --format="%H|%s|%ci"`, {
        cwd: this.vaultPath,
        encoding: 'utf-8',
      });

      return result
        .trim()
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => {
          const [hash, message, date] = line.split('|');
          return { hash, message, date };
        });
    } catch {
      return [];
    }
  }

  // Get files changed today
  getChangesToday(): VaultChange[] {
    if (!this.hasGit()) return [];

    try {
      // Find the first commit of today
      const today = new Date().toISOString().split('T')[0];
      const result = execSync(`git log --since="${today} 00:00:00" --until="${today} 23:59:59" --format="%H" | tail -1`, {
        cwd: this.vaultPath,
        encoding: 'utf-8',
        shell: '/bin/bash',
      });

      const firstCommitToday = result.trim();
      if (!firstCommitToday) return [];

      // Get parent of first commit today
      const parentResult = execSync(`git rev-parse ${firstCommitToday}^`, {
        cwd: this.vaultPath,
        encoding: 'utf-8',
      });

      const parentHash = parentResult.trim();
      return this.getChangesSince(parentHash);
    } catch {
      return [];
    }
  }

  // Get files modified in the last N hours
  getRecentChanges(hours: number = 24): VaultChange[] {
    if (!this.hasGit()) return [];

    try {
      const result = execSync(`git diff --name-status HEAD~${hours * 2}..HEAD 2>/dev/null || git diff --name-status $(git rev-list -n1 --before="${hours} hours ago" HEAD)..HEAD`, {
        cwd: this.vaultPath,
        encoding: 'utf-8',
        shell: '/bin/bash',
      });

      return this.parseGitDiff(result);
    } catch {
      return [];
    }
  }

  // Check if there are uncommitted changes
  hasUncommittedChanges(): boolean {
    if (!this.hasGit()) return false;

    try {
      const result = execSync('git status --porcelain', {
        cwd: this.vaultPath,
        encoding: 'utf-8',
      });
      return result.trim().length > 0;
    } catch {
      return false;
    }
  }

  // Get list of uncommitted files
  getUncommittedFiles(): VaultChange[] {
    if (!this.hasGit()) return [];

    try {
      const result = execSync('git status --porcelain', {
        cwd: this.vaultPath,
        encoding: 'utf-8',
      });

      return result
        .trim()
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => {
          const status = line.slice(0, 2).trim();
          const path = line.slice(3);

          let type: VaultChange['type'] = 'modified';
          if (status === '??') type = 'added';
          else if (status === 'A') type = 'added';
          else if (status === 'D') type = 'deleted';
          else if (status.startsWith('R')) type = 'renamed';

          return { type, path };
        });
    } catch {
      return [];
    }
  }

  // Parse git diff --name-status output
  private parseGitDiff(output: string): VaultChange[] {
    return output
      .trim()
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        const parts = line.split('\t');
        const status = parts[0];
        const path = parts[1];
        const oldPath = parts[2]; // For renames

        let type: VaultChange['type'] = 'modified';
        if (status === 'A') type = 'added';
        else if (status === 'D') type = 'deleted';
        else if (status.startsWith('R')) type = 'renamed';

        return { type, path, oldPath };
      });
  }

  // Create a checkpoint commit (for after assistant makes changes)
  createCheckpoint(message?: string): string | null {
    if (!this.hasGit()) return null;

    try {
      // Stage all changes
      execSync('git add -A', { cwd: this.vaultPath });

      // Check if there's anything to commit
      const status = execSync('git status --porcelain', {
        cwd: this.vaultPath,
        encoding: 'utf-8',
      });

      if (!status.trim()) return null;

      // Create commit
      const commitMessage = message ?? `checkpoint: ${new Date().toISOString().replace('T', ' ').slice(0, 16)}`;
      execSync(`git commit -m "${commitMessage}"`, { cwd: this.vaultPath });

      return this.getCurrentCommit();
    } catch {
      return null;
    }
  }
}
