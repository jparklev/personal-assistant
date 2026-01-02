import { Events } from 'discord.js';
import { loadConfig } from './config';
import { defaultState, StateStore } from './state';
import { logJson } from './log';
import { createDiscordClient } from './discord/client';
import { createDiscordTransport } from './discord/transport';
import { registerEventHandlers } from './discord/events';
import { ensureMemoryDirs, initializeMemoryFiles } from './memory';
import { ensureCapturesDir } from './captures';

async function main() {
  const cfg = loadConfig();

  if (!cfg.discordToken) {
    throw new Error('DISCORD_BOT_TOKEN not set. Add it to your .env file.');
  }
  if (!cfg.discordAppId) {
    throw new Error('DISCORD_APP_ID not set. Add it to your .env file.');
  }

  console.log('Starting Personal Assistant...');
  console.log(`  Vault: ${cfg.vaultPath}`);
  console.log(`  Assistant Dir: ${cfg.assistantDir}`);

  // Initialize memory directories and files
  ensureMemoryDirs();
  initializeMemoryFiles();
  ensureCapturesDir();

  const store = new StateStore(cfg.stateFile, defaultState());

  const client = createDiscordClient();
  const transport = createDiscordTransport(client);

  registerEventHandlers(client, { cfg, state: store, transport });

  client.once(Events.ClientReady, async (c) => {
    console.log(`\nDiscord bot ready as ${c.user.tag}`);
    console.log(`  Guilds: ${c.guilds.cache.size}`);
    console.log('\nListening for commands...');
    logJson({ event: 'ready', user: c.user.tag, guilds: c.guilds.cache.size });
  });

  client.on('error', (error) => {
    console.error('Discord client error:', error);
    logJson({ event: 'error', error: String(error) });
  });

  client.on('warn', (message) => {
    console.warn('Discord warning:', message);
  });

  await client.login(cfg.discordToken);
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exitCode = 1;
});
