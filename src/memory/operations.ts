/**
 * Memory Operations
 *
 * Convenience functions for common memory operations built on the
 * file-system based memory store.
 */

import { readState, writeState, writeMemory } from './filesystem';
import type {
  StandingQuestion,
  MorningCheckinState,
  ClipperState,
} from './types';
import { DEFAULT_STANDING_QUESTIONS } from './types';

interface QuestionsState {
  questions: StandingQuestion[];
}

// ============== Goals ==============

interface GoalsState {
  active: string[];
  archived: { goal: string; archivedAt: string }[];
}

const DEFAULT_GOALS: GoalsState = {
  active: [],
  archived: [],
};

function getGoalsState(): GoalsState {
  return readState<GoalsState>('goals', DEFAULT_GOALS);
}

function saveGoalsState(state: GoalsState): void {
  writeState('goals', state);
  // Also update human-readable markdown
  const lines = ['# Goals', '', '## Active Goals'];
  state.active.forEach((g) => lines.push(`- ${g}`));
  if (state.archived.length > 0) {
    lines.push('', '## Archived Goals');
    state.archived.slice(-10).forEach((a) => {
      lines.push(`- ${a.goal} [archived: ${a.archivedAt.split('T')[0]}]`);
    });
  }
  writeMemory('context/goals.md', lines.join('\n') + '\n');
}

export function setGoals(goals: string[]): void {
  const state = getGoalsState();
  state.active = goals;
  saveGoalsState(state);
}

export function getGoals(): string[] {
  return getGoalsState().active;
}

export function addGoal(goal: string): void {
  const state = getGoalsState();
  if (!state.active.includes(goal)) {
    state.active.push(goal);
    saveGoalsState(state);
  }
}

export function archiveGoal(goal: string): boolean {
  const state = getGoalsState();
  const index = state.active.indexOf(goal);
  if (index !== -1) {
    state.active.splice(index, 1);
    state.archived.push({ goal, archivedAt: new Date().toISOString() });
    saveGoalsState(state);
    return true;
  }
  return false;
}

export function getArchivedGoals(): { goal: string; archivedAt: string }[] {
  return getGoalsState().archived;
}

// ============== Standing Questions ==============

function getQuestionsState(): QuestionsState {
  return readState<QuestionsState>('questions', {
    questions: DEFAULT_STANDING_QUESTIONS,
  });
}

function saveQuestionsState(state: QuestionsState): void {
  writeState('questions', state);
}

export function getDueQuestions(): StandingQuestion[] {
  const state = getQuestionsState();
  const today = new Date().toISOString().split('T')[0];

  return state.questions.filter((q) => {
    if (!q.enabled) return false;

    if (!q.lastAsked) return true;

    const lastAskedDate = q.lastAsked.split('T')[0];
    if (lastAskedDate === today) return false;

    if (q.frequency === 'daily') return true;
    if (q.frequency === 'weekly') {
      const daysSinceAsked = Math.floor(
        (new Date().getTime() - new Date(q.lastAsked).getTime()) / (1000 * 60 * 60 * 24)
      );
      return daysSinceAsked >= 7;
    }
    if (q.frequency === 'occasional') {
      return Math.random() < 0.3;
    }

    return false;
  });
}

export function markQuestionAsked(id: string): void {
  const state = getQuestionsState();
  const question = state.questions.find((q) => q.id === id);
  if (question) {
    question.lastAsked = new Date().toISOString();
    saveQuestionsState(state);
  }
}

export function addQuestion(question: Omit<StandingQuestion, 'lastAsked'>): void {
  const state = getQuestionsState();
  const exists = state.questions.some((q) => q.id === question.id);
  if (!exists) {
    state.questions.push({ ...question, lastAsked: null });
    saveQuestionsState(state);
  }
}

export function updateQuestion(id: string, updates: Partial<Pick<StandingQuestion, 'enabled' | 'frequency' | 'question'>>): boolean {
  const state = getQuestionsState();
  const question = state.questions.find((q) => q.id === id);
  if (question) {
    Object.assign(question, updates);
    saveQuestionsState(state);
    return true;
  }
  return false;
}

export function removeQuestion(id: string): boolean {
  const state = getQuestionsState();
  const index = state.questions.findIndex((q) => q.id === id);
  if (index !== -1) {
    state.questions.splice(index, 1);
    saveQuestionsState(state);
    return true;
  }
  return false;
}

export function getAllQuestions(): StandingQuestion[] {
  return getQuestionsState().questions;
}

// ============== Morning Checkin ==============

const DEFAULT_MORNING_CHECKIN: MorningCheckinState = {
  lastRun: null,
  lastChannelId: null,
};

export function updateMorningCheckin(channelId: string): void {
  writeState('morning-checkin', {
    lastRun: new Date().toISOString(),
    lastChannelId: channelId,
  });
}

export function getMorningCheckinState(): MorningCheckinState {
  return readState<MorningCheckinState>('morning-checkin', DEFAULT_MORNING_CHECKIN);
}

// ============== Clipper Processing ==============

const DEFAULT_CLIPPER: ClipperState = {
  lastRun: null,
  processedFiles: [],
};

export function getClipperState(): ClipperState {
  return readState<ClipperState>('clipper-processing', DEFAULT_CLIPPER);
}

export function markClipperFileProcessed(filePath: string): void {
  const state = getClipperState();
  if (!state.processedFiles.includes(filePath)) {
    state.processedFiles.push(filePath);
  }
  state.lastRun = new Date().toISOString();
  writeState('clipper-processing', state);
}
