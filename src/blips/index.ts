export * from './types';
export { FileBlipStore, getFileBlipStore } from './file-store';
export type { BlipIndexEntry } from './file-store';
export {
  captureFromDiscord,
  captureFromInbox,
  captureFromClipper,
  captureFromDailyNote,
  captureManual,
  guessCategory,
} from './capture';
export type { CaptureResult } from './capture';

// Legacy export for backwards compatibility
export { getFileBlipStore as getBlipStore } from './file-store';
