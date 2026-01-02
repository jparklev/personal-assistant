import { homedir } from 'os';
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

export function loadConfig(): AppConfig {
  const home = homedir();
  const defaultVaultPath = join(home, 'Library/Mobile Documents/iCloud~md~Obsidian/Documents/Personal');
  const defaultAssistantDir = join(home, '.assistant');

  const vaultPath = process.env.OBSIDIAN_VAULT_PATH?.trim() || defaultVaultPath;

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
