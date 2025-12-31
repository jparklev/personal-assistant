import { SlashCommandBuilder } from 'discord.js';

export const commands = [
  // Blips - Personal Assistant
  new SlashCommandBuilder()
    .setName('blip')
    .setDescription('Capture and manage blips (small ideas and noticings)')
    .addSubcommand((sub) =>
      sub
        .setName('capture')
        .setDescription('Capture a new blip')
        .addStringOption((opt) => opt.setName('content').setDescription('The blip content').setRequired(true))
        .addStringOption((opt) =>
          opt
            .setName('category')
            .setDescription('Category')
            .setChoices(
              { name: 'idea', value: 'idea' },
              { name: 'question', value: 'question' },
              { name: 'goal', value: 'goal' },
              { name: 'todo', value: 'todo' },
              { name: 'quote', value: 'quote' },
              { name: 'reference', value: 'reference' },
              { name: 'curiosity', value: 'curiosity' },
              { name: 'other', value: 'other' }
            )
        )
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('List recent blips'))
    .addSubcommand((sub) =>
      sub
        .setName('surface')
        .setDescription('Surface blips ready for attention')
        .addIntegerOption((opt) => opt.setName('count').setDescription('Number of blips to surface (default: 3)'))
    )
    .addSubcommand((sub) =>
      sub
        .setName('note')
        .setDescription('Add a note to a blip')
        .addStringOption((opt) => opt.setName('id').setDescription('Blip ID').setRequired(true))
        .addStringOption((opt) => opt.setName('note').setDescription('Note to add').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('snooze')
        .setDescription('Snooze a blip for later')
        .addStringOption((opt) => opt.setName('id').setDescription('Blip ID').setRequired(true))
        .addIntegerOption((opt) => opt.setName('days').setDescription('Days to snooze (default: 7)'))
    )
    .addSubcommand((sub) =>
      sub
        .setName('archive')
        .setDescription('Archive a blip')
        .addStringOption((opt) => opt.setName('id').setDescription('Blip ID').setRequired(true))
    )
    .addSubcommand((sub) => sub.setName('stats').setDescription('Show blip statistics'))
    .addSubcommand((sub) => sub.setName('process').setDescription('Process inbox and clipper for new blips')),

  // Assistant settings
  new SlashCommandBuilder()
    .setName('assistant')
    .setDescription('Personal assistant settings')
    .addSubcommand((sub) =>
      sub
        .setName('enable')
        .setDescription('Enable or disable the assistant')
        .addBooleanOption((opt) => opt.setName('enabled').setDescription('Enable assistant').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('channel')
        .setDescription('Set a channel for assistant features')
        .addStringOption((opt) =>
          opt
            .setName('type')
            .setDescription('Channel type')
            .setRequired(true)
            .setChoices(
              { name: 'Morning Check-in', value: 'morningCheckin' },
              { name: 'Questions', value: 'questions' },
              { name: 'Blips', value: 'blips' },
              { name: 'Captures', value: 'captures' }
            )
        )
        .addChannelOption((opt) => opt.setName('channel').setDescription('Channel to use').setRequired(true))
    )
    .addSubcommand((sub) => sub.setName('status').setDescription('Show assistant status and configuration'))
    .addSubcommand((sub) => sub.setName('sync').setDescription('Sync with Obsidian vault')),

  // Utility
  new SlashCommandBuilder().setName('help').setDescription('Show available commands'),
];

export const commandsJson = commands.map((cmd) => cmd.toJSON());
