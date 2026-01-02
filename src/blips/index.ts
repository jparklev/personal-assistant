/**
 * Blips Module
 *
 * A file-first design for "little noticings that seem important."
 * Blips live in the Obsidian vault as markdown files with YAML frontmatter.
 */

// Types
export type { BlipStatus, BlipFrontmatter, BlipSummary, Blip, BlipMove } from './types';

// File operations
export {
  ensureBlipsDir,
  listBlips,
  findBlipBySource,
  canonicalizeBlipSource,
  readBlip,
  createBlip,
  appendToLog,
  updateStatus,
  snoozeBlip,
  archiveBlip,
  bumpToProject,
  touchBlip,
} from './files';
export type { CreateBlipOptions } from './files';

// Clippings processing
export { processClippings, listPendingClippings } from './clippings';

// Surfacing
export {
  getBlipsToSurface,
  findRelated,
  getActiveBlipsSummary,
  formatBlipForDisplay,
} from './surface';

// Moves
export { suggestMoves, formatMoveSuggestions } from './moves';
export type { MoveSuggestion } from './moves';
