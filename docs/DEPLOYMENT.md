# Deployment + Operations (VPS)

This bot is intended to run on a VPS (e.g. DigitalOcean) as a long-lived process via `systemd`.

The Obsidian vault is a git repo on disk. **Sync is external** (e.g. `vault-sync.sh` on a timer). The bot only reads/writes the working tree via `OBSIDIAN_VAULT_PATH`.

## Current Deployment

| Resource | Value |
|----------|-------|
| **Droplet** | `personal-assistant` |
| **IP** | `143.198.101.198` |
| **Region** | sfo3 (San Francisco) |
| **Size** | s-1vcpu-1gb |
| **OS** | Ubuntu 24.04 |

### Quick Commands

```bash
# SSH
ssh assistant@143.198.101.198

# View logs
ssh root@143.198.101.198 journalctl -u personal-assistant -f

# Restart
ssh root@143.198.101.198 systemctl restart personal-assistant

# Status
ssh root@143.198.101.198 systemctl status personal-assistant

# Manual vault sync
ssh assistant@143.198.101.198 /home/assistant/bin/vault-sync.sh
```

## Conventions

- Bot repo: `/home/assistant/personal-assistant`
- Vault repo: `/home/assistant/obsidian-vaults/personal`
- Runtime state: `/home/assistant/.assistant`
  - `state.json` - Discord channel IDs, managed channels, assistant enabled state
  - `scheduler.json` - Schedule configuration (morning/evening check-in times, weekly reconsolidation)
  - `flashcards.json` - Spaced repetition flashcard deck
  - `channels/<id>/memory.md` - Per-channel memory files for managed channels

## Prereqs

- A Linux box (Ubuntu 22.04/24.04 is fine)
- `git`, `curl`
- Bun installed
- Claude Code CLI installed + authenticated (needed for assistant runs; also used for conflict resolution if sync hits conflicts)

## Install (one-time)

1) Create a user:

```bash
adduser assistant
usermod -aG sudo assistant
```

2) Install deps:

```bash
apt-get update
apt-get install -y git curl ca-certificates
```

3) Install Bun (as the `assistant` user):

```bash
curl -fsSL https://bun.sh/install | bash
```

4) Clone repos:

```bash
mkdir -p /home/assistant/obsidian-vaults
git clone https://github.com/jparklev/obsidian-personal.git /home/assistant/obsidian-vaults/personal
git clone https://github.com/jparklev/personal-assistant.git /home/assistant/personal-assistant
```

### Git auth on a server

For unattended pull/push from the VPS, prefer an SSH deploy key. If you decide to use a GitHub Personal Access Token (PAT) instead, use a fine-grained PAT with the minimum repo permissions required.

PAT notes:
- Do not paste tokens into shell history if you can avoid it.
- Git credential storage on disk is typically plain text; lock down permissions.

One pragmatic approach (HTTPS + stored credentials):

```bash
# Configure git to store creds in ~/.git-credentials (plain text)
git config --global credential.helper store
chmod 700 "$HOME"

# Clone using the normal URL (no token embedded)
git clone https://github.com/<owner>/<repo>.git /home/assistant/obsidian-vaults/personal

# First push/pull will prompt for username/token once; then it persists.
```

Alternative (more explicit but easier to leak): set the remote URL to include the token. Avoid this if you can.

5) Configure env:

Create `/home/assistant/personal-assistant/.env`:

```bash
DISCORD_BOT_TOKEN=...
DISCORD_APP_ID=...
OBSIDIAN_VAULT_PATH=/home/assistant/obsidian-vaults/personal
```

6) Install bot deps:

```bash
cd /home/assistant/personal-assistant
/home/assistant/.bun/bin/bun install
/home/assistant/.bun/bin/bun run typecheck
/home/assistant/.bun/bin/bun run build
```

## Run the bot (systemd)

Create `/etc/systemd/system/personal-assistant.service`:

```ini
[Unit]
Description=Personal Assistant (Discord bot)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=assistant
WorkingDirectory=/home/assistant/personal-assistant
EnvironmentFile=/home/assistant/personal-assistant/.env
Environment="PATH=/home/assistant/.bun/bin:/usr/local/bin:/usr/bin:/bin"
ExecStart=/home/assistant/.bun/bin/bun dist/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

Enable + start:

```bash
systemctl daemon-reload
systemctl enable --now personal-assistant
```

Logs:

```bash
journalctl -u personal-assistant -f
```

## Deploy Discord slash commands

Run from the bot repo:

```bash
cd /home/assistant/personal-assistant
/home/assistant/.bun/bin/bun run deploy:commands
```

## Vault sync (read/write) with conflict handling

Goal: regularly pull remote changes, commit any local working-tree updates (from the bot), and push. Conflicts should be resolved carefully without losing content.

### Script: `vault-sync.sh`

Create `/home/assistant/bin/vault-sync.sh` (and `chmod +x`):

```bash
#!/usr/bin/env bash
set -euo pipefail

VAULT_DIR="${OBSIDIAN_VAULT_PATH:-$HOME/obsidian-vaults/personal}"
LOCK="/tmp/obsidian-vault-sync.lock"

mkdir -p "$HOME/bin"
exec 9>"$LOCK"
flock -n 9 || exit 0

cd "$VAULT_DIR"

git fetch origin

# Commit local changes (bot writes to the working tree; it does not create git commits).
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  if ! git diff --cached --quiet; then
    git commit -m "assistant: checkpoint $(date -Is)"
  fi
fi

# Prefer a merge (not rebase) for simpler conflict resolution.
if ! git pull --no-rebase --no-edit; then
  echo "vault-sync: git pull had conflicts; invoking claude to resolve carefully" >&2

  cat > /tmp/vault-conflict-prompt.txt <<'EOF'
You are resolving git merge conflicts in an Obsidian vault (markdown notes).

Rules:
- Do NOT lose any content.
- When in doubt, keep BOTH versions (combine sections).
- Preserve YAML frontmatter validity.
- Keep dates, names, and links exactly as written.
- Only remove conflict markers after you have merged the content.

Task:
1) Find conflicted files via `git status`.
2) Open each conflicted file and resolve conflicts carefully.
3) Run `git add -A`.
4) Complete the merge with `git commit` if needed.
5) Summarize what you did in 3-6 bullets.
EOF

  # Requires Claude Code CLI installed + authenticated on the server.
  if ! command -v claude >/dev/null 2>&1; then
    echo "vault-sync: 'claude' CLI not found on PATH; install/auth it or resolve conflicts manually" >&2
    exit 1
  fi

  claude --dangerously-skip-permissions -p "$(cat /tmp/vault-conflict-prompt.txt)"

  if [ -n "$(git diff --name-only --diff-filter=U)" ]; then
    echo "vault-sync: conflicts still present after claude; refusing to push" >&2
    git status --porcelain >&2 || true
    exit 1
  fi
  if [ -f .git/MERGE_HEAD ]; then
    echo "vault-sync: merge still in progress after claude; refusing to push" >&2
    git status --porcelain >&2 || true
    exit 1
  fi
fi

git push origin HEAD
```

Notes:
- This script intentionally makes small “checkpoint” commits when the bot changed files.
- If you also edit the vault from another machine, conflicts are possible; the prompt is biased toward “keep both”.

### Schedule sync (systemd timer)

Create `/etc/systemd/system/vault-sync.service`:

```ini
[Unit]
Description=Sync Obsidian vault git working tree

[Service]
Type=oneshot
User=assistant
EnvironmentFile=/home/assistant/personal-assistant/.env
ExecStart=/home/assistant/bin/vault-sync.sh
```

Create `/etc/systemd/system/vault-sync.timer`:

```ini
[Unit]
Description=Run vault sync periodically

[Timer]
OnBootSec=2m
OnUnitActiveSec=5m
Persistent=true

[Install]
WantedBy=timers.target
```

Enable:

```bash
systemctl daemon-reload
systemctl enable --now vault-sync.timer
systemctl list-timers --all | grep vault-sync
```

## Automated Deployment (GitHub Actions)

Pushes to `main` automatically deploy to the VPS via GitHub Actions.

### Required Secrets

Configure these in GitHub repo settings (Settings > Secrets and variables > Actions):

| Secret | Value |
|--------|-------|
| `VPS_HOST` | `143.198.101.198` |
| `VPS_USER` | `assistant` |
| `VPS_SSH_KEY` | Private SSH key with access to VPS |

### Generating a deploy key

```bash
# Generate a dedicated deploy key
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/deploy_key -N ""

# Add public key to VPS (both users need it)
ssh-copy-id -i ~/.ssh/deploy_key.pub assistant@143.198.101.198
ssh-copy-id -i ~/.ssh/deploy_key.pub root@143.198.101.198

# Copy private key content to GitHub secret VPS_SSH_KEY
cat ~/.ssh/deploy_key
```

### Manual Upgrades

Bot repo:

```bash
cd /home/assistant/personal-assistant
git pull --ff-only
/home/assistant/.bun/bin/bun install
/home/assistant/.bun/bin/bun run typecheck
/home/assistant/.bun/bin/bun run build
systemctl restart personal-assistant
```

Vault repo is updated by `vault-sync.timer`.
