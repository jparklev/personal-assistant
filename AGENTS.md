# AGENTS.md

Instructions + operational notes for future Codex agents working in this repo.

## What this repo is

Discord bot (“Personal Agent”) with two primary UX surfaces:

- `#blips`: capture ideas/URLs into Obsidian `Blips/` + store full raw capture outside the vault.
- `#assistant` (lobby): create/delete managed channels (with confirmation) under the configured category; also works as a normal assistant chat channel.
- Any channel under the configured “Personal Assistant” category (plus managed channels): run Claude Code CLI with takopi-style progress, per-thread queueing, and `/cancel`.

## Takopi lessons we adopted (why things are shaped this way)

Takopi (https://github.com/banteg/takopi) is a Telegram bridge that makes agent CLIs feel native by:

- Editing a single progress message (rate-limited; skip unchanged) instead of spamming new messages.
- Rendering progress from stable action IDs (tool/command lines update in-place: `▸` → `✓/✗`).
- Per-thread serialization + queue depth display (`queue: N`) by editing the same progress message.
- `/cancel` by replying to the progress message (kills the underlying process).
- Claude runner uses `--output-format stream-json --verbose`.
- Claude runner defaults to subscription auth (no API key): it strips `ANTHROPIC_API_KEY` unless configured otherwise.

We mirror the above:

- Claude is invoked with `--output-format stream-json --verbose --dangerously-skip-permissions`.
- Progress parsing uses `tool_use` / `tool_result` IDs for stable updates.
- Replies to an in-flight progress message are queued; progress message is edited to include `queue: N`.
- Reply `/cancel` (or `stop`) cancels the in-flight run and edits progress to `Cancelled.`.

Key files:

- `src/assistant/runner.ts`: Claude CLI runner + stream-json parsing + cancellation.
- `src/assistant/progress.ts`: progress renderer.
- `src/discord/events.ts`: routing, queueing, reply-to-in-flight, `/cancel`.

## Managed channels (“channel spawning”)

We support creating purpose-built channels from a single lobby channel (recommended name: `#assistant`).

Properties:

- Creation is **lobby-only** and requires a **confirmation reply** (`confirm` / `cancel`).
- Each created channel is added to `assistant.managedChannelIds` in `state/assistant.json` and treated like an assistant channel.
- Each created channel gets per-channel additive memory at `~/.assistant/channels/<channelId>/memory.md` (outside the Obsidian vault).
- Managed channels still have access to shared resources: the Obsidian vault (including captures in `Clippings/`).

Setup:

- Set lobby: `/assistant channel type: Lobby channel: #assistant`
- Set category: `/assistant category category: <Personal Assistant category>`

Fallbacks (to reduce config friction):

- If lobby isn’t configured, a channel literally named `assistant` is treated as the lobby.
- If category isn’t configured, a category literally named `Personal Assistant` is used.

In the lobby channel, ask:

- “create channel for equities research” → bot replies with a proposal → reply `confirm` to create.
- (Deletion is not implemented yet; delete channels manually for now.)

## Capture/Blips storage conventions (important)

- All captures live in the Obsidian vault's `Clippings/` folder (git-synced with the vault).
- A blip note in the vault links to its capture:
  - frontmatter includes `capture: <filename>.md` (when single primary URL)
  - body includes `Full capture: Clippings/<filename>.md`

URL capture pipeline:

- `src/captures/capture-url.ts`: writes `Clippings/<date>-<title>.md` in the vault
  - articles: extracted text + raw HTML (may be truncated)
  - Pocket Casts: transcript scrape fallback (no Whisper required if transcript exists)
  - YouTube: optional `yt-dlp` + `mlx_whisper` pipeline if installed

## How to run locally

Install/deps:

- `bun install`
- set `.env` (needs `DISCORD_BOT_TOKEN`, `DISCORD_APP_ID`, and usually guild/channel config)

Run bot:

- `bun run start`
- recommended: use `tmux` (one window for bot logs, another for experiments)

Basic checks after edits:

- `bun run typecheck`
- `bun run build`

## How to test (Discord UX) locally

### 1) Blip + capture

In `#blips`, post a URL.

Expected:

- bot replies with `Captured blip <filename>.md`
- capture file created in vault's `Clippings/`
- blip created in the vault `Blips/` with `capture: ...` frontmatter

### 2) Reply-to-bot in #blips (follow-up)

Reply to the bot’s capture message with e.g. “Summarize this”:

- should run assistant flow (reads the capture file) instead of re-capturing.

### 3) In-flight queueing (takopi-style)

In any assistant channel (a managed channel, or a channel under the assistant category), start a long run (example prompt that forces a long shell command):

- “please run `bash -lc 'sleep 25'` and do nothing else until it finishes.”

While it’s running:

- reply to the progress message twice with follow-ups.

Expected:

- no separate “queued…” messages
- progress message gets edited to show `queue: 1`, then `queue: 2`
- follow-ups run sequentially after the first run finishes

### 4) Cancel

While a run is in progress, reply to the progress message with:

- `/cancel`

Expected:

- bot replies `cancelling…`
- progress message is edited to `Cancelled.`

### 5) Lobby channel spawn/delete

In the lobby channel (configured via `/assistant channel`):

- “create channel for demo” → reply `confirm`
  - expect a new channel under the configured category
  - expect `~/.assistant/channels/<newId>/memory.md` created
- (Deletion is not implemented yet.)

### 6) Blips stream (Components V2)

In `#blips-stream` (or a channel configured as `Blips Stream` via `/assistant channel`):

- The bot should keep a single message updated with a “current blip” card + buttons.
- Clicking `Next` should touch the current blip and advance to the next due blip.
- Clicking `Thoughts` should open a modal; submitting should append to `## Log` and advance.
- Clicking `Prompt` should show 1–3 questions + `Answer/Skip` buttons (no advance until you answer/skip).
- Clicking `Answer` should open a modal; submitting should append Qs + answer to `## Log` and advance.
- Clicking `Do move` should ask Claude to pick a single move, append a log entry (and optional extra markdown), and advance.
- Clicking `Snooze 1d/7d/30d` should set `status: snoozed` + `snoozed_until: <today+Nd>` and advance.
- Clicking `Related` should toggle an expanded view (button label becomes `Back`) without advancing.

## Discord Components V2 note (optional future UX)

We briefly prototyped “Reacord-style” Discord Components V2 progress cards for assistant runs, but reverted it for now in favor of:

- progress in a code block (edited in-place)
- final answer as normal message text (edited in-place)

If we try V2 again later, two sharp edges to remember:

- Once a message has `MessageFlags.IsComponentsV2`, you **cannot** edit it back into a non-V2 message. (So “final answer as normal text” requires sending a new message + deleting the progress card.)
- A `ComponentType.Section` is only valid if it has an `accessory` (button/thumbnail). For “no cancel button” states, use a `TextDisplay` header instead of a Section.

We *do* use Components V2 in `#blips-stream` because it’s an interactive “one blip at a time” feed (buttons), and the message is intended to stay V2 forever.

## UI automation (MCP) notes

Playwright MCP tends to be the most reliable for Discord message sending:

- use it to post in `#blips`, reply to messages, and validate progress edits.
- helpful trick: in a stuck UI, you can enumerate channel links + IDs from the DOM via `page.evaluate(...)` (search `a[href^="/channels/<guildId>/"]`).

Chrome DevTools MCP can navigate Discord but may require a one-time login in its profile:

- current intended profile dir: `~/.cache/chrome-devtools-mcp/canary-profile`
- if you see the Discord login screen in the MCP browser, log in once; then it should persist.

## Known sharp edges / TODOs

- Discord markdown can make progress text look messy; code-block rendering is a high-ROI polish.
- Throttling progress edits to ~2s (takopi-style) usually makes runs feel calmer and avoids rate limits.
- If queued follow-ups stop working, check `src/assistant/sessions.ts` for state-schema drift (older `state/sessions.json` may be missing `metadata` / `timestamps`).
