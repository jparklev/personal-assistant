/**
 * Health Context Builder
 *
 * Provides minimal context for Claude to understand current health state.
 * Claude is trusted to explore the vault for details as needed.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { isoDateForAssistant } from '../time';
import { getDaysSinceLastLog } from './state';

export interface ProtocolState {
  active: boolean;
  name?: string;
  phase?: number;
  phaseName?: string;
  dayNumber?: number;
  totalDays?: number;
  startDate?: string;
}

/**
 * Parse the Sulfur Roadmap Tracking file for protocol state.
 * Returns { active: false } if no active protocol or file not found.
 */
export function getProtocolState(vaultPath: string, opts?: { now?: Date }): ProtocolState {
  const trackingPath = join(vaultPath, 'Health & Wellness', 'Sulfur Roadmap Tracking.md');
  const at = opts?.now || new Date();

  if (!existsSync(trackingPath)) {
    return { active: false };
  }

  try {
    const content = readFileSync(trackingPath, 'utf-8');

    // Look for start date in format "Started: YYYY-MM-DD" or "Start date: YYYY-MM-DD"
    const startMatch = content.match(/(?:started|start\s*date)\s*:\s*(\d{4}-\d{2}-\d{2})/i);
    if (!startMatch) {
      return { active: false };
    }

    const startDate = startMatch[1];
    const today = isoDateForAssistant(at);
    const start = new Date(startDate);
    const todayDate = new Date(today);

    // Calculate day number (1-indexed)
    const msPerDay = 24 * 60 * 60 * 1000;
    const dayNumber = Math.floor((todayDate.getTime() - start.getTime()) / msPerDay) + 1;

    // Determine phase based on day number
    // Phase 1: Days 1-30 (Low Sulfur Diet)
    // Phase 2: Days 31-60 (Molybdenum Introduction)
    // Phase 3: Days 61-90 (Sulfur Reintroduction)
    // Phase 4: Days 91+ (Maintenance)
    let phase = 1;
    let phaseName = 'Low Sulfur Diet';
    let totalDays: number | undefined = 30;

    if (dayNumber > 90) {
      phase = 4;
      phaseName = 'Maintenance';
      totalDays = undefined;
    } else if (dayNumber > 60) {
      phase = 3;
      phaseName = 'Sulfur Reintroduction';
      totalDays = 90;
    } else if (dayNumber > 30) {
      phase = 2;
      phaseName = 'Molybdenum Introduction';
      totalDays = 60;
    }

    return {
      active: true,
      name: 'Sulfur Roadmap',
      phase,
      phaseName,
      dayNumber,
      totalDays,
      startDate,
    };
  } catch {
    return { active: false };
  }
}

/**
 * Get the date of the last supplement log entry.
 */
export function getLastSupplementLogDate(vaultPath: string): string | null {
  const logPath = join(vaultPath, 'Health & Wellness', 'Supplements', 'Log.md');

  if (!existsSync(logPath)) {
    return null;
  }

  try {
    const content = readFileSync(logPath, 'utf-8');

    // Look for date headers like "### 2026-01-06"
    const dateMatches = content.matchAll(/^###\s+(\d{4}-\d{2}-\d{2})/gm);
    const dates: string[] = [];
    for (const match of dateMatches) {
      if (match[1]) dates.push(match[1]);
    }

    if (dates.length === 0) return null;

    // Return the most recent date (last one in file, or sort if needed)
    return dates.sort().reverse()[0];
  } catch {
    return null;
  }
}

/**
 * Build minimal health context for Claude.
 *
 * This gives Claude just enough to understand the current state.
 * Claude is trusted to Read files from the vault for details.
 */
export function buildHealthContext(vaultPath: string, opts?: { now?: Date }): string {
  const at = opts?.now || new Date();
  const protocol = getProtocolState(vaultPath, { now: at });
  const lastLogDate = getLastSupplementLogDate(vaultPath);
  const today = isoDateForAssistant(at);

  const lines: string[] = [];

  // Protocol state
  if (protocol.active) {
    lines.push(`## Current Protocol`);
    lines.push('');
    lines.push(`**${protocol.name}** - Phase ${protocol.phase}: ${protocol.phaseName}`);
    lines.push(`Day ${protocol.dayNumber}${protocol.totalDays ? ` of ${protocol.totalDays}` : ''}`);
    lines.push(`Started: ${protocol.startDate}`);
    lines.push('');
  } else {
    lines.push(`## Current Protocol`);
    lines.push('');
    lines.push('No active protocol. In maintenance/drift mode.');
    lines.push('');
  }

  // Last log info
  if (lastLogDate) {
    const daysSince = Math.floor(
      (new Date(today).getTime() - new Date(lastLogDate).getTime()) / (24 * 60 * 60 * 1000)
    );
    if (daysSince === 0) {
      lines.push(`Last supplement log: today (${lastLogDate})`);
    } else if (daysSince === 1) {
      lines.push(`Last supplement log: yesterday (${lastLogDate})`);
    } else {
      lines.push(`Last supplement log: ${daysSince} days ago (${lastLogDate})`);
    }
  } else {
    lines.push(`No supplement logs found.`);
  }
  lines.push('');

  // Key file locations
  lines.push(`## Health Files (vault: ${vaultPath})`);
  lines.push('');
  lines.push('- `Health & Wellness/Health Goals & Roadmap.md` - priorities, bloodwork, experiments');
  lines.push('- `Health & Wellness/Health Profile.md` - shareable overview, what works/doesnt');
  lines.push('- `Health & Wellness/Sulfur Roadmap Tracking.md` - active protocol details');
  lines.push('- `Health & Wellness/Supplements/Log.md` - supplement experiment log');
  lines.push('- `Health & Wellness/Supplements/Stack.md` - current daily stack');
  lines.push('- `Daily/YYYY-MM-DD.md` - daily notes for symptoms/energy');
  lines.push('');

  // Instructions
  lines.push(`## Your Role`);
  lines.push('');
  lines.push('You are Josh\'s health assistant. You have access to his full health context in the vault.');
  lines.push('');
  lines.push('**When logging:**');
  lines.push('- Supplements → append to `Health & Wellness/Supplements/Log.md`');
  lines.push(`- Symptoms/energy → append to \`Daily/${today}.md\` under a \`## Health\` section`);
  lines.push('- Use Edit tool to append, preserving existing content');
  lines.push('- Never add a top-level heading (# YYYY-MM-DD) to daily notes — Obsidian shows the filename as the title');
  lines.push('');
  lines.push('**Key context:**');
  lines.push('- Read `Health & Wellness/Health Profile.md` for constraints and what tends to backfire');
  lines.push('- Read `Health & Wellness/Health Goals & Roadmap.md` for current priorities');
  lines.push('');
  lines.push('**Style:**');
  lines.push('- Concise, not verbose');
  lines.push('- Ask clarifying questions when needed');
  lines.push('- Encourage thinking, don\'t just give answers');

  return lines.join('\n');
}

export function buildHealthCheckinMessage(vaultPath: string): {
  text: string;
  protocol: ProtocolState;
  lastLogDate: string | null;
  daysSinceLog: number | null;
} {
  const protocol = getProtocolState(vaultPath);
  const lastLogDate = getLastSupplementLogDate(vaultPath);
  const daysSinceLog = getDaysSinceLastLog(lastLogDate);

  const lines: string[] = [];

  if (protocol.active) {
    lines.push(`**Day ${protocol.dayNumber} of ${protocol.name}** (${protocol.phaseName})`);
    lines.push('');
  }

  lines.push('How are you feeling today? Any symptoms to note?');
  lines.push('');

  if (lastLogDate && daysSinceLog !== null && daysSinceLog > 1) {
    lines.push(`_(No supplement log since ${lastLogDate}. No pressure, just checking in.)_`);
  }

  return {
    text: lines.join('\n').trim().slice(0, 2000),
    protocol,
    lastLogDate,
    daysSinceLog,
  };
}
