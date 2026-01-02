import { Client, GatewayIntentBits, Partials } from 'discord.js';

export function createDiscordClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageTyping,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.ThreadMember],
  });
}
