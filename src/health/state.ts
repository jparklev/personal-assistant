/**
 * Health Check-in State
 *
 * Tracks check-in interactions to avoid spamming and adjust frequency.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { isoDateForAssistant } from '../time';

export interface HealthState {
  lastCheckinSent: string | null; // ISO date
  lastUserResponse: string | null; // ISO date
  consecutiveNoResponse: number;
}

const DEFAULT_STATE: HealthState = {
  lastCheckinSent: null,
  lastUserResponse: null,
  consecutiveNoResponse: 0,
};

function getStatePath(): string {
  return join(homedir(), '.assistant', 'health', 'state.json');
}

export function readHealthState(): HealthState {
  const path = getStatePath();

  if (!existsSync(path)) {
    return { ...DEFAULT_STATE };
  }

  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      lastCheckinSent: parsed.lastCheckinSent || null,
      lastUserResponse: parsed.lastUserResponse || null,
      consecutiveNoResponse: parsed.consecutiveNoResponse || 0,
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function writeHealthState(state: Partial<HealthState>): void {
  const path = getStatePath();
  const current = readHealthState();
  const updated = { ...current, ...state };

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(updated, null, 2), 'utf-8');
}

/**
 * Record that a check-in was sent.
 */
export function recordCheckinSent(): void {
  const today = isoDateForAssistant(new Date());
  const state = readHealthState();

  writeHealthState({
    lastCheckinSent: today,
    // If no response since the last check-in, increment counter.
    consecutiveNoResponse:
      state.lastCheckinSent &&
      (!state.lastUserResponse || state.lastUserResponse < state.lastCheckinSent)
        ? state.consecutiveNoResponse + 1
        : state.consecutiveNoResponse,
  });
}

/**
 * Record that the user responded in the health channel.
 */
export function recordUserResponse(): void {
  writeHealthState({
    lastUserResponse: isoDateForAssistant(new Date()),
    consecutiveNoResponse: 0,
  });
}

/**
 * Check if we should send a check-in today.
 *
 * Rules:
 * - Don't send if we already sent today
 * - If 3+ consecutive no-responses, only send weekly
 */
export function shouldSendCheckin(): { send: boolean; reason: string } {
  const state = readHealthState();
  const today = isoDateForAssistant(new Date());

  // Already sent today
  if (state.lastCheckinSent === today) {
    return { send: false, reason: 'Already sent check-in today' };
  }

  // Reduce frequency if no responses
  if (state.consecutiveNoResponse >= 3) {
    if (!state.lastCheckinSent) {
      return { send: true, reason: 'First check-in' };
    }

    const lastSent = new Date(state.lastCheckinSent);
    const now = new Date(today);
    const daysSince = Math.floor((now.getTime() - lastSent.getTime()) / (24 * 60 * 60 * 1000));

    if (daysSince < 7) {
      return {
        send: false,
        reason: `Reducing frequency due to ${state.consecutiveNoResponse} consecutive no-responses (${daysSince} days since last)`,
      };
    }
  }

  return { send: true, reason: 'Time for check-in' };
}

/**
 * Get days since last supplement log.
 */
export function getDaysSinceLastLog(lastLogDate: string | null): number | null {
  if (!lastLogDate) return null;

  const today = isoDateForAssistant(new Date());
  const last = new Date(lastLogDate);
  const now = new Date(today);

  return Math.floor((now.getTime() - last.getTime()) / (24 * 60 * 60 * 1000));
}
