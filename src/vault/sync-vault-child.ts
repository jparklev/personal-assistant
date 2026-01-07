import { syncVaultChanges } from './git-sync';

async function main(): Promise<void> {
  const vaultPath = process.argv[2];
  const commitMessage = process.argv[3];

  if (!vaultPath || !commitMessage) {
    console.error('Usage: sync-vault-child.ts <vaultPath> <commitMessage>');
    process.exit(1);
  }

  const result = await syncVaultChanges(vaultPath, commitMessage);
  if (!result.ok) {
    console.error('[VaultSyncChild] Failed:', result.message);
    process.exit(1);
  }

  console.log('[VaultSyncChild]', result.message);
  process.exit(0);
}

main().catch((err) => {
  console.error('[VaultSyncChild] Error:', err?.message || String(err));
  process.exit(1);
});

