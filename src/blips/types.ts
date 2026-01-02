/**
 * Blips: File-First Design
 *
 * Blips are "little noticings that seem important" - they live in the vault
 * as markdown files with YAML frontmatter for progressive disclosure.
 */

export type BlipStatus = 'active' | 'snoozed' | 'archived' | 'bumped';

export interface BlipFrontmatter {
  title: string;
  status: BlipStatus;
  created: string;
  touched: string;
  tags?: string[];
  related?: string[];
  source?: string;
  author?: string;
  published?: string;
  capture?: string;
  snoozed_until?: string;
  bumped_to?: string;
}

export interface BlipSummary {
  path: string;
  filename: string;
  title: string;
  status: BlipStatus;
  created: string;
  touched: string;
  tags?: string[];
  source?: string;
}

export interface Blip extends BlipSummary {
  frontmatter: BlipFrontmatter;
  content: string;
  hasLog: boolean;
}

export type BlipMove =
  | 'find-link'
  | 'break-down'
  | 'connect'
  | 'collect-examples'
  | 'decide'
  | 'summarize'
  | 'annotate'
  | 'bump-to-project'
  | 'snooze'
  | 'archive';
