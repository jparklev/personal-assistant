export {
  getProtocolState,
  getLastSupplementLogDate,
  buildHealthContext,
  buildHealthCheckinMessage,
  type ProtocolState,
} from './context';

export {
  readHealthState,
  writeHealthState,
  recordCheckinSent,
  recordUserResponse,
  shouldSendCheckin,
  getDaysSinceLastLog,
  type HealthState,
} from './state';
