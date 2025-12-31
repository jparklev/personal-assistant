/**
 * Memory Types
 *
 * Types for the file-system based memory store. Each type corresponds to
 * data stored in a specific file within ~/.assistant/
 *
 * File structure:
 *   state/learner.json      -> LearnerState (corrections, patterns, preferences)
 *   state/questions.json    -> QuestionsState (standing questions)
 *   state/vault-sync.json   -> VaultSyncState
 *   state/morning-checkin.json -> MorningCheckinState
 *   state/clipper-processing.json -> ClipperState
 *   context/goals.md        -> Goals (markdown)
 *   context/user.md         -> User context (markdown)
 *   knowledge/corrections.md -> Human-readable corrections log
 *   knowledge/patterns.md   -> Human-readable patterns log
 */

// ============== Learner State (state/learner.json) ==============

export interface Correction {
  id: string;
  originalAction: string;
  correction: string;
  context: string;
  createdAt: string;
  appliedCount: number;
}

/**
 * Simple observation about the user - no confidence scores,
 * just notes the assistant records over time.
 */
export interface Observation {
  id: string;
  note: string; // "Prefers morning check-ins", "Interested in TypeScript"
  source: 'stated' | 'inferred'; // Did user say it, or did we infer it?
  recordedAt: string;
}

/** @deprecated Use Observation instead */
export interface UserPattern {
  id: string;
  type: 'active-hours' | 'topic-interest' | 'behavior' | 'preference';
  description: string;
  confidence: number;
  observedAt: string;
  evidence: string[];
}

export interface UserPreference {
  id: string;
  key: string;
  value: string;
  source: 'explicit' | 'inferred';
  updatedAt: string;
}

// ============== Questions State (state/questions.json) ==============

export interface StandingQuestion {
  id: string;
  question: string;
  category: 'reflection' | 'accountability' | 'learning' | 'social';
  frequency: 'daily' | 'weekly' | 'occasional';
  lastAsked: string | null;
  enabled: boolean;
}

export const DEFAULT_STANDING_QUESTIONS: StandingQuestion[] = [
  {
    id: 'what-learned',
    question: 'What did you learn today?',
    category: 'learning',
    frequency: 'daily',
    lastAsked: null,
    enabled: true,
  },
  {
    id: 'grateful-for',
    question: 'What are you grateful for today?',
    category: 'reflection',
    frequency: 'daily',
    lastAsked: null,
    enabled: true,
  },
  {
    id: 'reached-out',
    question: 'Did you reach out to anyone today?',
    category: 'social',
    frequency: 'daily',
    lastAsked: null,
    enabled: true,
  },
  {
    id: 'writing-progress',
    question: 'Did you make progress on any writing today?',
    category: 'accountability',
    frequency: 'daily',
    lastAsked: null,
    enabled: true,
  },
];

// ============== Vault Sync State (state/vault-sync.json) ==============

export interface VaultSyncState {
  lastSyncAt: string | null;
  lastCommitHash: string | null;
}

// ============== Morning Checkin State (state/morning-checkin.json) ==============

export interface MorningCheckinState {
  lastRun: string | null;
  lastChannelId: string | null;
}

// ============== Clipper State (state/clipper-processing.json) ==============

export interface ClipperState {
  lastRun: string | null;
  processedFiles: string[];
}
