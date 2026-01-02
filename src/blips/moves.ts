/**
 * Move suggestions for blips
 *
 * Moves are scaffolded microtasks that help advance a blip
 * when you don't know what to do next.
 */

import type { Blip, BlipMove } from './types';
import { findRelated } from './surface';

export interface MoveSuggestion {
  move: BlipMove;
  label: string;
  description: string;
  reason: string;
}

/**
 * Suggest moves for a blip based on its current state
 */
export function suggestMoves(blip: Blip): MoveSuggestion[] {
  const suggestions: MoveSuggestion[] = [];

  // Check for related blips
  const relatedPaths = findRelated(blip.path);
  const hasRelated = relatedPaths.length > 0;

  // Check content characteristics
  const content = blip.content.toLowerCase();
  const hasSource = !!blip.source;
  const hasHighlights = blip.content.includes('## Highlights');
  const hasLog = blip.hasLog;
  const isLong = blip.content.length > 2000;

  // Intent detection
  const wantsToLearn = /want to learn|curious about|look into|explore|understand/i.test(content);
  const hasOptions = /or\b|option|should i|which|decide/i.test(content);
  const isBigGoal = /goal|project|plan|build|create|implement/i.test(content);
  const isAesthetic = /aesthetic|style|pattern|example|inspiration|collection/i.test(content);

  // Find a link - for learning intentions
  if (wantsToLearn && !hasSource) {
    suggestions.push({
      move: 'find-link',
      label: 'Find a link',
      description: 'Search for relevant resources',
      reason: 'You mentioned wanting to learn more',
    });
  }

  // Break it down - for big goals/projects
  if (isBigGoal) {
    suggestions.push({
      move: 'break-down',
      label: 'Break it down',
      description: 'Identify smaller first steps',
      reason: 'This seems like a larger goal',
    });
  }

  // Connect - when similar blips exist
  if (hasRelated) {
    suggestions.push({
      move: 'connect',
      label: 'Connect',
      description: `Found ${relatedPaths.length} related blip(s)`,
      reason: 'Similar content exists in other blips',
    });
  }

  // Collect examples - for aesthetic/pattern blips
  if (isAesthetic) {
    suggestions.push({
      move: 'collect-examples',
      label: 'Collect examples',
      description: 'Gather more examples over time',
      reason: 'Building a collection might help',
    });
  }

  // Decide - when options are mentioned
  if (hasOptions) {
    suggestions.push({
      move: 'decide',
      label: 'Decide',
      description: 'Quick voting/ranking exercise',
      reason: 'There seem to be multiple options',
    });
  }

  // Summarize - for long article content
  if (hasSource && isLong) {
    suggestions.push({
      move: 'summarize',
      label: 'Summarize',
      description: 'Extract key points',
      reason: 'This is a long article',
    });
  }

  // Annotate - for articles without highlights
  if (hasSource && !hasHighlights) {
    suggestions.push({
      move: 'annotate',
      label: 'Annotate',
      description: 'What stood out? Any reactions?',
      reason: 'No highlights or reactions yet',
    });
  }

  // Bump to project - always an option for active blips
  if (blip.status === 'active') {
    suggestions.push({
      move: 'bump-to-project',
      label: 'Bump to project',
      description: 'Move to Projects/ for focused work',
      reason: 'Ready for deeper exploration',
    });
  }

  // Snooze - always an option
  suggestions.push({
    move: 'snooze',
    label: 'Snooze',
    description: 'Come back to this later',
    reason: 'Not ready to work on this now',
  });

  // Archive - always an option
  suggestions.push({
    move: 'archive',
    label: 'Archive',
    description: "Done with this blip (won't surface again)",
    reason: 'No longer relevant or needed',
  });

  return suggestions;
}

/**
 * Format move suggestions for display
 */
export function formatMoveSuggestions(suggestions: MoveSuggestion[]): string {
  const lines = ['**Suggested moves:**', ''];

  for (let i = 0; i < suggestions.length; i++) {
    const s = suggestions[i];
    lines.push(`${i + 1}. **${s.label}** - ${s.description}`);
  }

  return lines.join('\n');
}
