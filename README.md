# Personal Assistant

A proactive personal assistant with Discord interface, focused on capturing ideas, learning over time, and encouraging thinking rather than just providing answers.

## Philosophy

- **Capture small ideas (blips)** before they fade
- **Progressive disclosure** - lightweight indexes, load full content on demand
- **Accountable partner** - surfaces incomplete commitments, asks follow-ups
- **Math Academy style** - encourages thinking, doesn't just give answers

## Quick Start

```bash
bun install
cp .env.example .env   # Add DISCORD_BOT_TOKEN, DISCORD_APP_ID, DISCORD_GUILD_ID
bun run deploy:commands
bun run start
```

Operational notes: `docs/DEPLOYMENT.md`.

## Data Storage

Everything lives in `~/.assistant/`:

```
~/.assistant/
├── memory.md           # Pointers, preferences, remembered facts, corrections
├── blips/              # One file per idea/blip
│   └── <id>.md
├── captures/           # Captured URLs, podcasts, videos
│   └── <date>-<title>.md
└── state/              # Task state, sync tracking
```

## Discord Commands

**Blips** (small ideas to incubate)
- `/blip capture <content>` - Capture a new blip
- `/blip list` - Show recent blips
- `/blip surface` - Get blips ready for review
- `/blip note <id> <note>` - Add a note to a blip
- `/blip snooze <id>` - Hide for a while
- `/blip archive <id>` - Archive a blip

**Captures** (post a URL in the blips channel)
- YouTube videos - extracts transcript via yt-dlp or mlx-whisper
- Podcasts - transcribes audio with mlx-whisper
- Articles - extracts main content
- PDFs - extracts text

**Settings**
- `/assistant enable` - Turn assistant on/off
- `/assistant channel <type> <channel>` - Set channels for morning/blips/lobby
- `/assistant category <category>` - Set the category for assistant-created channels
- `/assistant status` - Show configuration
- `/assistant sync` - Sync vault changes

**Blips Stream** (one blip at a time, with buttons)
- Create a channel named `blips-stream` (or set it explicitly via `/assistant channel type: Blips Stream`)
- The bot keeps a single “current blip” card updated (Components V2) with buttons like Next/Thoughts/Prompt/Do move/Snooze/Related/Bump/Archive

## Scheduled Tasks

**Morning Check-in** (7:00 AM daily)
- Yesterday's daily note - incomplete items, #followups
- Apple Reminders due today
- Vault changes since last check (git-based)
- Blips ready for review
- Standing questions

**Weekly Reconsolidation** (Sunday 6:00 PM)
- Reviews stale blips (>30 days)
- Extracts patterns from the week's captures
- Updates memory.md with learnings
- Archives old blips

### Install Schedules (macOS)

```bash
cp launchd/*.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.assistant.morning.plist
launchctl load ~/Library/LaunchAgents/com.assistant.weekly.plist

# Or run manually
bun run task:morning
bun run task:weekly
```

## Requirements

- Node/Bun
- Discord bot token
- Claude Code CLI (`claude`)
- yt-dlp (for YouTube)
- mlx-whisper (for podcast transcription)

## License

MIT
