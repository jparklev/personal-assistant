/**
 * Session Store
 *
 * Maps Discord message IDs to Claude session IDs.
 * This allows stateless resume without visible tokens in messages.
 */

import { readState, writeState } from '../memory/filesystem';

interface SessionMetadata {
  model?: string;
  type?: string;
}

interface SessionMap {
  // messageId -> sessionId
  sessions: Record<string, string>;
  // sessionId -> metadata
  metadata: Record<string, SessionMetadata>;
  // Track creation time for cleanup
  timestamps: Record<string, number>;
}

const STATE_KEY = 'sessions';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function load(): SessionMap {
  const raw = readState<any>(STATE_KEY, { sessions: {}, metadata: {}, timestamps: {} });
  const sessions = raw && typeof raw.sessions === 'object' && raw.sessions ? raw.sessions : {};
  const metadata = raw && typeof raw.metadata === 'object' && raw.metadata ? raw.metadata : {};
  const timestamps = raw && typeof raw.timestamps === 'object' && raw.timestamps ? raw.timestamps : {};
  return { sessions, metadata, timestamps };
}

function save(map: SessionMap): void {
  writeState(STATE_KEY, map);
}

/**
 * Store a session ID for a message.
 */
export function storeSession(messageId: string, sessionId: string): void {
  const map = load();
  map.sessions[messageId] = sessionId;
  map.timestamps[messageId] = Date.now();
  save(map);
}

/**
 * Get session ID for a message, if one exists.
 */
export function getSession(messageId: string): string | null {
  const map = load();
  return map.sessions[messageId] || null;
}

/**
 * Set metadata for a session.
 */
export function setSessionMetadata(sessionId: string, metadata: SessionMetadata): void {
  const map = load();
  map.metadata[sessionId] = { ...(map.metadata[sessionId] || {}), ...metadata };
  save(map);
}

/**
 * Get metadata for a session.
 */
export function getSessionMetadata(sessionId: string): SessionMetadata | undefined {
  const map = load();
  return map.metadata[sessionId];
}

/**
 * Clean up old sessions (call periodically).
 */
export function cleanupSessions(): number {
  const map = load();
  const now = Date.now();
  let removed = 0;
  const activeSessionIds = new Set<string>();

  // Identify active sessions
  for (const messageId of Object.keys(map.timestamps)) {
    if (now - map.timestamps[messageId] <= MAX_AGE_MS) {
      const sid = map.sessions[messageId];
      if (sid) activeSessionIds.add(sid);
    }
  }

  // Remove old message mappings
  for (const messageId of Object.keys(map.timestamps)) {
    if (now - map.timestamps[messageId] > MAX_AGE_MS) {
      delete map.sessions[messageId];
      delete map.timestamps[messageId];
      removed++;
    }
  }

  // Remove orphaned metadata (if not referenced by any active session)
  // Note: This is a loose cleanup strategy
  for (const sessionId of Object.keys(map.metadata || {})) {
    if (!activeSessionIds.has(sessionId)) {
      delete map.metadata[sessionId];
    }
  }

  if (removed > 0) {
    save(map);
  }

  return removed;
}
