import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';

export interface AssistantStateConfig {
  enabled: boolean;
  categoryId?: string;
  managedChannelIds?: string[];
  channels: {
    morningCheckin?: string;
    blips?: string; // Unified channel for blips + captures
    blipsStream?: string;
    lobby?: string;
    meditationLogs?: string; // Voice logs appended to daily notes
    dailies?: string; // Daily voice notes appended to daily notes
    flashcards?: string; // Spaced repetition flashcard review
    health?: string; // Health assistant channel
  };
}

export interface AppState {
  version: 1;
  config: {
    guildId?: string;
  };
  assistant: AssistantStateConfig;
}

class Mutex {
  private chain = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }
}

export function defaultState(): AppState {
  return {
    version: 1,
    config: {},
    assistant: {
      enabled: true,
      managedChannelIds: [],
      channels: {},
    },
  };
}

export class StateStore {
  private filePath: string;
  private mutex = new Mutex();
  private state: AppState;

  constructor(filePath: string, initial: AppState) {
    this.filePath = filePath;
    this.state = this.loadFromDisk(initial);
  }

  get snapshot(): AppState {
    return this.state;
  }

  async transact<T>(fn: (state: AppState) => Promise<T>): Promise<T> {
    return await this.mutex.run(async () => {
      const out = await fn(this.state);
      this.saveToDisk(this.state);
      return out;
    });
  }

  // Assistant channel management
  setAssistantChannel(
    type: 'morningCheckin' | 'blips' | 'blipsStream' | 'lobby' | 'meditationLogs' | 'dailies' | 'flashcards' | 'health',
    channelId: string | undefined
  ): void {
    if (!channelId) {
      delete this.state.assistant.channels[type];
    } else {
      this.state.assistant.channels[type] = channelId;
    }
  }

  getAssistantChannel(type: 'morningCheckin' | 'blips' | 'blipsStream' | 'lobby' | 'meditationLogs' | 'dailies' | 'flashcards' | 'health'): string | undefined {
    return this.state.assistant.channels[type];
  }

  setAssistantCategory(categoryId: string | undefined): void {
    if (!categoryId) {
      delete this.state.assistant.categoryId;
    } else {
      this.state.assistant.categoryId = categoryId;
    }
  }

  addManagedChannel(channelId: string): void {
    const list = (this.state.assistant.managedChannelIds ||= []);
    if (!list.includes(channelId)) list.push(channelId);
  }

  removeManagedChannel(channelId: string): void {
    const list = this.state.assistant.managedChannelIds;
    if (!list) return;
    const next = list.filter((id) => id !== channelId);
    this.state.assistant.managedChannelIds = next;
  }

  setAssistantEnabled(enabled: boolean): void {
    this.state.assistant.enabled = enabled;
  }

  isAssistantEnabled(): boolean {
    return this.state.assistant.enabled;
  }

  private loadFromDisk(fallback: AppState): AppState {
    if (!existsSync(this.filePath)) return fallback;
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as any;

      const assistantConfig = parsed?.assistant ?? { enabled: true, channels: {} };
      const managedChannelIds = Array.isArray(assistantConfig.managedChannelIds)
        ? assistantConfig.managedChannelIds.filter((id: any) => typeof id === 'string')
        : [];

      const rawChannels = assistantConfig.channels ?? {};
      const channels: AssistantStateConfig['channels'] = {};
      if (typeof rawChannels.morningCheckin === 'string') channels.morningCheckin = rawChannels.morningCheckin;
      if (typeof rawChannels.blips === 'string') channels.blips = rawChannels.blips;
      if (typeof rawChannels.blipsStream === 'string') channels.blipsStream = rawChannels.blipsStream;
      if (typeof rawChannels.lobby === 'string') channels.lobby = rawChannels.lobby;
      if (typeof rawChannels.meditationLogs === 'string') channels.meditationLogs = rawChannels.meditationLogs;
      if (typeof rawChannels.dailies === 'string') channels.dailies = rawChannels.dailies;
      if (typeof rawChannels.flashcards === 'string') channels.flashcards = rawChannels.flashcards;
      if (typeof rawChannels.health === 'string') channels.health = rawChannels.health;

      return {
        version: 1,
        config: parsed?.config ?? {},
        assistant: {
          enabled: assistantConfig.enabled !== false,
          categoryId: typeof assistantConfig.categoryId === 'string' ? assistantConfig.categoryId : undefined,
          managedChannelIds,
          channels,
        },
      };
    } catch {
      return fallback;
    }
  }

  private saveToDisk(state: AppState): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf-8');
    renameSync(tmp, this.filePath);
  }
}
