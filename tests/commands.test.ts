import { describe, expect, it } from 'bun:test';
import { commandsJson } from '../src/discord/commands';

describe('slash commands', () => {
  it('exposes flashcards as an assistant channel type option', () => {
    const assistant = commandsJson.find((c: any) => c.name === 'assistant') as any;
    expect(assistant).toBeTruthy();

    const channelSub = (assistant.options || []).find((o: any) => o.name === 'channel');
    expect(channelSub).toBeTruthy();

    const typeOpt = (channelSub.options || []).find((o: any) => o.name === 'type');
    expect(typeOpt).toBeTruthy();

    const values = (typeOpt.choices || []).map((c: any) => c.value);
    expect(values).toContain('flashcards');
    expect(values).toContain('meta');
  });
});
