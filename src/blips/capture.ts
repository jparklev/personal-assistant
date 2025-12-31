/**
 * Blip capture utilities.
 *
 * These are helper functions for capturing blips from different sources.
 * Claude Code can read the vault directly - these just provide consistent
 * source metadata when capturing.
 */

import type { BlipCategory, BlipSource } from './types';
import { getFileBlipStore } from './file-store';

export interface CaptureResult {
  success: boolean;
  blipId?: string;
  error?: string;
}

/**
 * Capture a blip from Discord
 */
export function captureFromDiscord(
  content: string,
  channelId: string,
  messageId: string,
  userId: string,
  category?: BlipCategory
): CaptureResult {
  if (!content.trim()) {
    return { success: false, error: 'Empty content' };
  }

  const source: BlipSource = {
    type: 'discord',
    channelId,
    messageId,
    userId,
  };

  const blip = getFileBlipStore().capture(content, source, category);
  return { success: true, blipId: blip.id };
}

/**
 * Capture a blip from the Note Inbox
 */
export function captureFromInbox(
  content: string,
  filePath: string,
  lineNumber?: number,
  category?: BlipCategory
): CaptureResult {
  if (!content.trim()) {
    return { success: false, error: 'Empty content' };
  }

  const source: BlipSource = {
    type: 'obsidian-inbox',
    filePath,
    lineNumber,
  };

  const blip = getFileBlipStore().capture(content, source, category);
  return { success: true, blipId: blip.id };
}

/**
 * Capture a blip from a clipper highlight
 */
export function captureFromClipper(
  content: string,
  filePath: string,
  highlightId: string,
  category?: BlipCategory
): CaptureResult {
  if (!content.trim()) {
    return { success: false, error: 'Empty content' };
  }

  const source: BlipSource = {
    type: 'clipper',
    filePath,
    highlightId,
  };

  const blip = getFileBlipStore().capture(content, source, category);
  return { success: true, blipId: blip.id };
}

/**
 * Capture a blip from a daily note
 */
export function captureFromDailyNote(
  content: string,
  date: string,
  lineNumber?: number,
  category?: BlipCategory
): CaptureResult {
  if (!content.trim()) {
    return { success: false, error: 'Empty content' };
  }

  const source: BlipSource = {
    type: 'daily-note',
    date,
    lineNumber,
  };

  const blip = getFileBlipStore().capture(content, source, category);
  return { success: true, blipId: blip.id };
}

/**
 * Manual capture with optional context
 */
export function captureManual(
  content: string,
  category?: BlipCategory,
  context?: string
): CaptureResult {
  if (!content.trim()) {
    return { success: false, error: 'Empty content' };
  }

  const source: BlipSource = {
    type: 'manual',
    context,
  };

  const blip = getFileBlipStore().capture(content, source, category);
  return { success: true, blipId: blip.id };
}

/**
 * Guess category from content
 */
export function guessCategory(content: string): BlipCategory {
  const lower = content.toLowerCase();

  if (lower.includes('?')) return 'question';
  if (lower.match(/\b(want|goal|should|need to|must)\b/)) return 'goal';
  if (lower.match(/\b(todo|task|do|finish|complete)\b/)) return 'todo';
  if (lower.match(/^["'"]/)) return 'quote';
  if (lower.match(/\b(article|book|paper|video|podcast)\b/)) return 'reference';
  if (lower.match(/\b(wonder|curious|why|how)\b/)) return 'curiosity';
  if (lower.match(/\b(idea|what if|could|maybe)\b/)) return 'idea';

  return 'other';
}
