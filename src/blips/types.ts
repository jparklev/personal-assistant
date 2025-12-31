export type BlipSource =
  | { type: 'discord'; channelId: string; messageId: string; userId: string }
  | { type: 'obsidian-inbox'; filePath: string; lineNumber?: number }
  | { type: 'clipper'; filePath: string; highlightId: string }
  | { type: 'daily-note'; date: string; lineNumber?: number }
  | { type: 'manual'; context?: string };

export type BlipState =
  | 'captured' // Just captured, not yet processed
  | 'incubating' // Being held for later surfacing
  | 'active' // Currently being worked on
  | 'evolved' // Has been developed into something
  | 'archived' // No longer active, but kept for reference
  | 'promoted'; // Promoted to vault (goal, project, etc)

export type BlipCategory = 'idea' | 'question' | 'goal' | 'todo' | 'quote' | 'reference' | 'curiosity' | 'other';

export interface Blip {
  id: string;
  content: string;
  source: BlipSource;
  state: BlipState;
  category?: BlipCategory;

  // Timestamps
  capturedAt: string;
  lastSurfacedAt?: string;
  lastUpdatedAt?: string;

  // Surfacing
  surfaceCount: number;
  nextSurfaceAfter?: string; // Don't show before this time
  surfaceFrequency?: 'daily' | 'weekly' | 'monthly' | 'on-demand';

  // Evolution
  notes: string[]; // User additions over time
  linkedBlips?: string[]; // Related blip IDs
  linkedVaultPaths?: string[]; // Links to Obsidian notes

  // Tags
  tags?: string[];

  // Promotion tracking
  promotedTo?: {
    type: 'goal' | 'project' | 'task' | 'note';
    vaultPath: string;
    promotedAt: string;
  };
}

// Actions user can take on a blip
export type BlipMove =
  | 'elaborate' // Add more detail
  | 'question' // Ask a clarifying question
  | 'connect' // Link to another blip or vault note
  | 'schedule' // Set when to resurface
  | 'promote' // Move to vault as goal/project/task
  | 'archive' // Done with this blip
  | 'incubate' // Put aside for later
  | 'snooze'; // Don't show for a while

export interface BlipSurfaceResult {
  blip: Blip;
  reason: string; // Why this blip was surfaced
  suggestedMoves: BlipMove[];
}

export interface BlipsState {
  version: 1;
  blips: Blip[];
  lastProcessedInbox?: string; // Hash or timestamp of last inbox processing
  lastProcessedClipper?: string; // Hash or timestamp of last clipper processing
}

export function defaultBlipsState(): BlipsState {
  return {
    version: 1,
    blips: [],
  };
}
