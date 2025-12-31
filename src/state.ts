import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';

export interface AssistantStateConfig {
  enabled: boolean;
  channels: {
    morningCheckin?: string;
    questions?: string;
    blips?: string;
    captures?: string;
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
  setAssistantChannel(type: 'morningCheckin' | 'questions' | 'blips' | 'captures', channelId: string | undefined): void {
    if (!channelId) {
      delete this.state.assistant.channels[type];
    } else {
      this.state.assistant.channels[type] = channelId;
    }
  }

  getAssistantChannel(type: 'morningCheckin' | 'questions' | 'blips' | 'captures'): string | undefined {
    return this.state.assistant.channels[type];
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

      return {
        version: 1,
        config: parsed?.config ?? {},
        assistant: {
          enabled: assistantConfig.enabled !== false,
          channels: assistantConfig.channels ?? {},
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
