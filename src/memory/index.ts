export type {
  Correction,
  Observation,
  UserPreference,
  StandingQuestion,
  VaultSyncState,
  MorningCheckinState,
  ClipperState,
  /** @deprecated Use Observation instead */
  UserPattern,
} from './types';
export { DEFAULT_STANDING_QUESTIONS } from './types';
export { Learner, getLearner } from './learner';

// File-system based memory (aligned with Anthropic's memory tool patterns)
export {
  ASSISTANT_DIR,
  ensureMemoryDirs,
  initializeMemoryFiles,
  view,
  create,
  strReplace,
  insert,
  deleteItem,
  rename,
  readMemory,
  writeMemory,
  appendMemory,
  readState,
  writeState,
  logInteraction,
  parseTemporalFacts,
  formatTemporalFact,
  type TemporalFact,
} from './filesystem';

// Convenience operations
export {
  // Vault sync
  getLastVaultSync,
  updateVaultSync,
  // Goals
  setGoals,
  getGoals,
  addGoal,
  archiveGoal,
  getArchivedGoals,
  // Questions
  getDueQuestions,
  markQuestionAsked,
  addQuestion,
  updateQuestion,
  removeQuestion,
  getAllQuestions,
  // Scheduler state
  updateMorningCheckin,
  getMorningCheckinState,
  getClipperState,
  markClipperFileProcessed,
} from './operations';
