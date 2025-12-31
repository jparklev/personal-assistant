export interface VaultConfig {
  path: string;
  writableFolders: string[]; // Folders we can write to
}

export interface VaultFile {
  path: string; // Relative to vault root
  content: string;
  modifiedAt: Date;
}

export interface VaultChange {
  type: 'added' | 'modified' | 'deleted' | 'renamed';
  path: string;
  oldPath?: string; // For renames
}

export interface DailyNote {
  date: string; // YYYY-MM-DD
  content: string;
  followups: FollowupItem[];
  tags: string[];
}

export interface FollowupItem {
  text: string;
  completed: boolean;
  line: number;
}

export interface GoalsDocument {
  path: string;
  goals: string[];
  mantras: string[];
  rawContent: string;
}

export interface ClipperHighlight {
  id: string;
  text: string;
  sourceFile: string;
  sourceUrl?: string;
  sourceTitle?: string;
  note?: string;
  capturedAt?: string;
}
