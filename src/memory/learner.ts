import { readMemory, appendMemory, readState, writeState } from './filesystem';
import type { Correction, Observation, UserPreference } from './types';
import { nanoid } from 'nanoid';

/**
 * The Learner module handles evolving knowledge about the user:
 * 1. Corrections - "don't do X, do Y instead"
 * 2. Observations - simple notes about the user
 * 3. Preferences - key/value pairs (explicit or inferred)
 *
 * All data is stored in state/learner.json with human-readable
 * logs in knowledge/*.md
 */

interface LearnerState {
  corrections: Correction[];
  observations: Observation[];
  preferences: UserPreference[];
}

function getState(): LearnerState {
  return readState<LearnerState>('learner', {
    corrections: [],
    observations: [],
    preferences: [],
  });
}

function saveState(state: LearnerState): void {
  writeState('learner', state);
}

export class Learner {
  // ============== Corrections ==============

  recordCorrection(originalAction: string, correction: string, context: string): void {
    const state = getState();
    const newCorrection: Correction = {
      id: nanoid(8),
      originalAction,
      correction,
      context,
      createdAt: new Date().toISOString(),
      appliedCount: 0,
    };
    state.corrections.push(newCorrection);
    saveState(state);

    const entry = `
### ${new Date().toISOString().split('T')[0]}
- Original: "${originalAction}"
- Correction: "${correction}"
- Context: ${context}
`;
    appendMemory('knowledge/corrections.md', entry);
  }

  getCorrections(context: string): Correction[] {
    const state = getState();
    const keywords = context.toLowerCase().split(/\s+/);
    return state.corrections.filter((c) => {
      const correctionWords = c.context.toLowerCase().split(/\s+/);
      return keywords.some((k) => correctionWords.includes(k));
    });
  }

  applyCorrection(id: string): void {
    const state = getState();
    const correction = state.corrections.find((c) => c.id === id);
    if (correction) {
      correction.appliedCount++;
      saveState(state);
    }
  }

  removeCorrection(id: string): boolean {
    const state = getState();
    const index = state.corrections.findIndex((c) => c.id === id);
    if (index !== -1) {
      state.corrections.splice(index, 1);
      saveState(state);
      return true;
    }
    return false;
  }

  getAllCorrections(): Correction[] {
    return getState().corrections;
  }

  // ============== Observations ==============

  recordObservation(note: string, source: 'stated' | 'inferred'): string {
    const state = getState();
    const id = nanoid(8);
    state.observations.push({
      id,
      note,
      source,
      recordedAt: new Date().toISOString(),
    });
    saveState(state);

    const entry = `- ${note} [${source}, ${new Date().toISOString().split('T')[0]}]\n`;
    appendMemory('knowledge/observations.md', entry);
    return id;
  }

  updateObservation(id: string, note: string): boolean {
    const state = getState();
    const obs = state.observations.find((o) => o.id === id);
    if (obs) {
      obs.note = note;
      obs.recordedAt = new Date().toISOString();
      saveState(state);
      return true;
    }
    return false;
  }

  removeObservation(id: string): boolean {
    const state = getState();
    const index = state.observations.findIndex((o) => o.id === id);
    if (index !== -1) {
      state.observations.splice(index, 1);
      saveState(state);
      return true;
    }
    return false;
  }

  getObservations(): Observation[] {
    return getState().observations;
  }

  // ============== Preferences ==============

  recordPreference(key: string, value: string, source: 'explicit' | 'inferred'): void {
    const state = getState();
    const existing = state.preferences.find((p) => p.key === key);
    if (existing) {
      existing.value = value;
      existing.source = source;
      existing.updatedAt = new Date().toISOString();
    } else {
      state.preferences.push({
        id: nanoid(8),
        key,
        value,
        source,
        updatedAt: new Date().toISOString(),
      });
    }
    saveState(state);
  }

  removePreference(key: string): boolean {
    const state = getState();
    const index = state.preferences.findIndex((p) => p.key === key);
    if (index !== -1) {
      state.preferences.splice(index, 1);
      saveState(state);
      return true;
    }
    return false;
  }

  getPreferences(): Record<string, string> {
    const state = getState();
    return Object.fromEntries(state.preferences.map((p) => [p.key, p.value]));
  }

  getAllPreferences(): UserPreference[] {
    return getState().preferences;
  }

  // ============== Context Building ==============

  buildContextPrompt(): string {
    const state = getState();
    const lines: string[] = [];

    const goalsContent = readMemory('context/goals.md');
    if (goalsContent) {
      lines.push('## User Goals');
      lines.push(goalsContent);
      lines.push('');
    }

    const userContent = readMemory('context/user.md');
    if (userContent) {
      lines.push('## User Context');
      lines.push(userContent);
      lines.push('');
    }

    if (state.preferences.length > 0) {
      lines.push('## Preferences');
      state.preferences.forEach((p) => {
        lines.push(`- ${p.key}: ${p.value}`);
      });
      lines.push('');
    }

    if (state.observations.length > 0) {
      lines.push('## Observations');
      state.observations.forEach((o) => {
        lines.push(`- ${o.note}`);
      });
      lines.push('');
    }

    if (state.corrections.length > 0) {
      const recent = state.corrections.slice(-5);
      lines.push('## Corrections');
      recent.forEach((c) => {
        lines.push(`- Instead of "${c.originalAction}", do "${c.correction}"`);
      });
      lines.push('');
    }

    return lines.join('\n');
  }
}

// Singleton
let _learner: Learner | null = null;

export function getLearner(): Learner {
  if (!_learner) {
    _learner = new Learner();
  }
  return _learner;
}
