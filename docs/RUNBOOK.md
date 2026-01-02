# Runbook (Personal Assistant)

This repo is a Discord bot (“Personal Assistant”) that runs via `bun` and logs to `/tmp/personal-assistant.log` when started with `nohup`.

## Check status

```bash
pgrep -fl "bun run src/index.ts"
tail -f /tmp/personal-assistant.log
```

## Start / restart

From this repo root:

```bash
# stop any existing instances first (avoid double-processing Discord events)
pkill -f "bun run src/index.ts" || true

nohup bun run src/index.ts > /tmp/personal-assistant.log 2>&1 &
tail -f /tmp/personal-assistant.log
```

## Stop

```bash
pkill -f "bun run src/index.ts" || true
```

## Deploy Discord slash commands

```bash
bun run deploy:commands
```

## Notes

- `nohup` survives terminal close but not reboot.
- For persistence across reboots, use `launchd` plists (see `launchd/` in this repo).
