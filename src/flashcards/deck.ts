/**
 * Flashcard Deck Management
 *
 * Handles storage and retrieval of flashcards.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type { Flashcard, FlashcardDeck, ReviewRating } from './types';
import { calculateNextReview, createFlashcard } from './types';

let deckPath: string | null = null;
let cachedDeck: FlashcardDeck | null = null;

/**
 * Initialize the deck manager with a storage path.
 */
export function initFlashcardDeck(assistantDir: string): void {
  deckPath = join(assistantDir, 'flashcards.json');
}

function ensureDeckPath(): string {
  if (!deckPath) {
    throw new Error('Flashcard deck not initialized. Call initFlashcardDeck first.');
  }
  return deckPath;
}

function loadDeck(): FlashcardDeck {
  const path = ensureDeckPath();

  if (cachedDeck) return cachedDeck;

  if (!existsSync(path)) {
    cachedDeck = { version: 1, cards: [] };
    return cachedDeck;
  }

  try {
    const raw = readFileSync(path, 'utf-8');
    cachedDeck = JSON.parse(raw);
    return cachedDeck!;
  } catch {
    cachedDeck = { version: 1, cards: [] };
    return cachedDeck;
  }
}

function saveDeck(deck: FlashcardDeck): void {
  const path = ensureDeckPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(deck, null, 2) + '\n', 'utf-8');
  renameSync(tmp, path);
  cachedDeck = deck;
}

/**
 * Get all flashcards.
 */
export function getAllCards(): Flashcard[] {
  return loadDeck().cards;
}

/**
 * Get cards due for review today (or overdue).
 */
export function getDueCards(): Flashcard[] {
  const today = new Date().toISOString().split('T')[0];
  const deck = loadDeck();

  return deck.cards
    .filter((card) => card.nextReview <= today)
    .sort((a, b) => a.nextReview.localeCompare(b.nextReview));
}

/**
 * Get a single card by ID.
 */
export function getCard(id: string): Flashcard | null {
  const deck = loadDeck();
  return deck.cards.find((c) => c.id === id) || null;
}

/**
 * Add a new flashcard.
 */
export function addCard(
  question: string,
  answer: string,
  options?: {
    sourceBlipPath?: string;
    sourceBlipTitle?: string;
    tags?: string[];
  }
): Flashcard {
  const deck = loadDeck();
  const card = createFlashcard(question, answer, options);
  deck.cards.push(card);
  saveDeck(deck);
  return card;
}

/**
 * Add multiple flashcards at once.
 */
export function addCards(
  cards: Array<{
    question: string;
    answer: string;
  }>,
  options?: {
    sourceBlipPath?: string;
    sourceBlipTitle?: string;
    tags?: string[];
  }
): Flashcard[] {
  const deck = loadDeck();
  const newCards = cards.map((c) =>
    createFlashcard(c.question, c.answer, options)
  );
  deck.cards.push(...newCards);
  saveDeck(deck);
  return newCards;
}

/**
 * Review a card with a rating.
 */
export function reviewCard(id: string, rating: ReviewRating): Flashcard | null {
  const deck = loadDeck();
  const cardIndex = deck.cards.findIndex((c) => c.id === id);

  if (cardIndex === -1) return null;

  const card = deck.cards[cardIndex];
  const updates = calculateNextReview(card, rating);

  const updatedCard: Flashcard = {
    ...card,
    ...updates,
    lastReviewed: new Date().toISOString().split('T')[0],
  };

  deck.cards[cardIndex] = updatedCard;
  saveDeck(deck);

  return updatedCard;
}

/**
 * Delete a card.
 */
export function deleteCard(id: string): boolean {
  const deck = loadDeck();
  const initialLength = deck.cards.length;
  deck.cards = deck.cards.filter((c) => c.id !== id);

  if (deck.cards.length < initialLength) {
    saveDeck(deck);
    return true;
  }

  return false;
}

/**
 * Get deck statistics.
 */
export function getDeckStats(): {
  total: number;
  due: number;
  new: number;
  learning: number;
  mature: number;
} {
  const deck = loadDeck();
  const today = new Date().toISOString().split('T')[0];

  let due = 0;
  let newCards = 0;
  let learning = 0;
  let mature = 0;

  for (const card of deck.cards) {
    if (card.nextReview <= today) due++;

    if (card.repetitions === 0) {
      newCards++;
    } else if (card.interval < 21) {
      learning++;
    } else {
      mature++;
    }
  }

  return {
    total: deck.cards.length,
    due,
    new: newCards,
    learning,
    mature,
  };
}

/**
 * Get cards from a specific source blip.
 */
export function getCardsFromBlip(blipPath: string): Flashcard[] {
  const deck = loadDeck();
  return deck.cards.filter((c) => c.sourceBlipPath === blipPath);
}
