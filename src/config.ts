import { homedir } from 'os';
import { existsSync } from 'fs';
import { join } from 'path';

export interface AppConfig {
  discordToken?: string;
  discordAppId?: string;
  discordGuildId?: string;
  stateFile: string;
  vaultPath: string;
  blipsDir: string;
  clippingsDir: string;
  projectsDir: string;
  assistantDir: string;
}

export function resolveVaultPath(home: string): string {
  const envVaultPath = process.env.OBSIDIAN_VAULT_PATH?.trim();
  if (envVaultPath) return envVaultPath;

  const candidates = [
    // New default local path (macOS dev). Example: /Users/joshlevine/obsidian-vaults/personal
    join(home, 'obsidian-vaults', 'personal'),
    // Legacy default (iCloud Obsidian). Keep as an auto-detect fallback.
    join(home, 'Library/Mobile Documents/iCloud~md~Obsidian/Documents/Personal'),
    // Simple VPS-friendly fallback.
    join(home, 'vault'),
  ];

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }

  // If none exist, pick the intended default and let callers decide whether to warn/throw.
  return candidates[0];
}

export function loadConfig(): AppConfig {
  const home = homedir();
  const defaultAssistantDir = join(home, '.assistant');

  // Vault sync is handled externally (e.g. a git pull/push script on a VPS).
  const vaultPath = resolveVaultPath(home);

  return {
    discordToken: process.env.DISCORD_BOT_TOKEN?.trim(),
    discordAppId: process.env.DISCORD_APP_ID?.trim(),
    discordGuildId: process.env.DISCORD_GUILD_ID?.trim(),
    stateFile: 'state/assistant.json',
    vaultPath,
    blipsDir: join(vaultPath, 'Blips'),
    clippingsDir: join(vaultPath, 'Clippings'),
    projectsDir: join(vaultPath, 'Projects'),
    assistantDir: process.env.ASSISTANT_DIR?.trim() || defaultAssistantDir,
  };
}
