/**
 * Flashcard Types
 *
 * Uses a simplified SM-2 spaced repetition algorithm.
 */

import { isoDateForAssistant } from '../time';

export interface Flashcard {
  id: string;
  question: string;
  answer: string;

  // Source tracking
  sourceBlipPath?: string;
  sourceBlipTitle?: string;

  // Spaced repetition fields
  easeFactor: number;      // Starts at 2.5, adjusts based on responses
  interval: number;        // Days until next review
  repetitions: number;     // Number of successful reviews
  nextReview: string;      // ISO date string (YYYY-MM-DD)

  // Metadata
  created: string;         // ISO date string
  lastReviewed?: string;   // ISO date string
  tags?: string[];
}

export interface FlashcardDeck {
  version: 1;
  cards: Flashcard[];
}

export type ReviewRating = 'again' | 'hard' | 'good' | 'easy';

/**
 * SM-2 quality scores for each rating.
 */
export const RATING_QUALITY: Record<ReviewRating, number> = {
  again: 0,  // Complete blackout
  hard: 2,   // Correct with serious difficulty
  good: 3,   // Correct with some difficulty
  easy: 5,   // Perfect response
};

/**
 * Calculate next review based on SM-2 algorithm.
 */
export function calculateNextReview(
  card: Flashcard,
  rating: ReviewRating
): Pick<Flashcard, 'easeFactor' | 'interval' | 'repetitions' | 'nextReview'> {
  const quality = RATING_QUALITY[rating];

  let { easeFactor, interval, repetitions } = card;

  if (quality < 3) {
    // Failed - reset repetitions
    repetitions = 0;
    interval = 1;
  } else {
    // Passed - update based on SM-2
    if (repetitions === 0) {
      interval = 1;
    } else if (repetitions === 1) {
      interval = 6;
    } else {
      interval = Math.round(interval * easeFactor);
    }
    repetitions++;
  }

  // Update ease factor
  easeFactor = Math.max(
    1.3,
    easeFactor + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02))
  );

  // Calculate next review date
  const nextReviewDate = new Date();
  nextReviewDate.setDate(nextReviewDate.getDate() + interval);
  const nextReview = isoDateForAssistant(nextReviewDate);

  return { easeFactor, interval, repetitions, nextReview };
}

/**
 * Create a new flashcard with default values.
 */
export function createFlashcard(
  question: string,
  answer: string,
  options?: {
    sourceBlipPath?: string;
    sourceBlipTitle?: string;
    tags?: string[];
  }
): Flashcard {
  const today = isoDateForAssistant(new Date());

  return {
    id: `fc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    question,
    answer,
    sourceBlipPath: options?.sourceBlipPath,
    sourceBlipTitle: options?.sourceBlipTitle,
    easeFactor: 2.5,
    interval: 0,
    repetitions: 0,
    nextReview: today, // Due immediately
    created: today,
    tags: options?.tags,
  };
}
