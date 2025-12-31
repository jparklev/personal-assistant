import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { ReacordDiscordJs } from 'reacord';

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

export function createReacord(client: Client): ReacordDiscordJs {
  return new ReacordDiscordJs(client);
}
