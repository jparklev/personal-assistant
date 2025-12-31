import { REST, Routes } from 'discord.js';
import { commandsJson } from './commands';

async function deploy() {
  const token = process.env.DISCORD_BOT_TOKEN;
  const appId = process.env.DISCORD_APP_ID;
  const guildId = process.env.DISCORD_GUILD_ID;

  if (!token || !appId) {
    console.error('Missing DISCORD_BOT_TOKEN or DISCORD_APP_ID');
    process.exit(1);
  }

  const rest = new REST({ version: '10' }).setToken(token);

  try {
    console.log(`Deploying ${commandsJson.length} commands...`);

    if (guildId) {
      await rest.put(Routes.applicationGuildCommands(appId, guildId), { body: commandsJson });
      console.log(`Deployed to guild ${guildId}`);
    } else {
      await rest.put(Routes.applicationCommands(appId), { body: commandsJson });
      console.log('Deployed globally');
    }
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

deploy();
