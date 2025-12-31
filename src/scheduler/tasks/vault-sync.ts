import { existsSync } from 'fs';
import type { SchedulerContext, TaskResult } from '../types';
import { VaultWatcher } from '../../vault/watcher';
import { getLastVaultSync, updateVaultSync } from '../../memory';
import { invokeClaudeCode, buildAssistantContext } from '../../assistant/invoke';

export async function runVaultSync(ctx: SchedulerContext): Promise<TaskResult> {
  const vaultWatcher = new VaultWatcher(ctx.vaultPath);

  if (!existsSync(ctx.vaultPath)) {
    return { success: false, message: `Vault not found at ${ctx.vaultPath}` };
  }

  if (!vaultWatcher.hasGit()) {
    return { success: false, message: 'Vault does not have git initialized' };
  }

  try {
    // Get current commit
    const currentCommit = vaultWatcher.getCurrentCommit();
    if (!currentCommit) {
      return { success: false, message: 'Could not get current commit' };
    }

    const lastSync = getLastVaultSync();

    // Get changes since last sync
    let changedFiles: { type: string; path: string }[] = [];
    if (lastSync.hash) {
      changedFiles = vaultWatcher.getChangesSince(lastSync.hash);
    }

    // If there are changes, invoke Claude Code to process them
    if (changedFiles.length > 0) {
      const changedSummary = changedFiles
        .slice(0, 20) // Limit to avoid huge prompts
        .map((f) => `${f.type}: ${f.path}`)
        .join('\n');

      const prompt = `You are the personal assistant. The Obsidian vault has been updated.

${buildAssistantContext()}

## Changed Files (since last sync)

${changedSummary}
${changedFiles.length > 20 ? `\n...and ${changedFiles.length - 20} more files` : ''}

## Your Task

1. Review the changed files to understand what's new
2. If Note Inbox.md changed, look for new items that might be blips worth capturing
3. If Clippings/ has new files, review them for interesting highlights
4. If goals files changed, note any goal updates

For now, just acknowledge you've processed the sync. In the future, you'll be able to capture blips and update memory.

Output a brief summary of what changed (1-2 sentences).`;

      await invokeClaudeCode({
        prompt,
        timeout: 60000,
      });
    }

    // Update sync state
    updateVaultSync(currentCommit);

    return {
      success: true,
      message: 'Vault sync completed',
      data: {
        changedFiles: changedFiles.length,
        commit: currentCommit.slice(0, 7),
      },
    };
  } catch (error: any) {
    return { success: false, message: error?.message || String(error) };
  }
}
