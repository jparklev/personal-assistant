import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const LOG_FILE = 'logs/discord.log';

// Token patterns to redact from logs (telegram bot tokens, API keys, etc.)
const TELEGRAM_TOKEN_RE = /bot\d+:[A-Za-z0-9_-]+/gi;
const BARE_TOKEN_RE = /\b\d{8,}:[A-Za-z0-9_-]{20,}\b/g;
// API keys: sk-xxx, sk_live_xxx, sk_test_xxx, key-xxx, xoxb-xxx, xoxp-xxx, etc.
const API_KEY_RE = /\b(sk[-_][A-Za-z0-9_-]{20,}|key[-_][A-Za-z0-9_-]{20,}|xox[a-z]-[A-Za-z0-9_-]{10,})\b/gi;

function redactSecrets(text: string): string {
  return text
    .replace(TELEGRAM_TOKEN_RE, 'bot[REDACTED]')
    .replace(BARE_TOKEN_RE, '[REDACTED_TOKEN]')
    .replace(API_KEY_RE, '[REDACTED_KEY]');
}

function redactObject(obj: any): any {
  if (typeof obj === 'string') return redactSecrets(obj);
  if (Array.isArray(obj)) return obj.map(redactObject);
  if (obj && typeof obj === 'object') {
    const out: any = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = redactObject(v);
    }
    return out;
  }
  return obj;
}

export function logLine(line: string): void {
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true });
    appendFileSync(LOG_FILE, redactSecrets(line) + '\n', 'utf-8');
  } catch {
    // ignore
  }
}

export function logJson(obj: any): void {
  const ts = new Date().toISOString();
  try {
    logLine(`${ts} ${JSON.stringify(redactObject(obj))}`);
  } catch {
    logLine(`${ts} ${String(obj)}`);
  }
}

