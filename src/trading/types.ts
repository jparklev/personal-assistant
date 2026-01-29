export type TradeStatus = 'Open' | 'Closed';

export interface TradeSummary {
  title: string;
  status: TradeStatus;
  symbol?: string;
  direction?: string;
  entry?: string;
}

export interface WatchedAssetSummary {
  asset: string;
  thesis?: string;
}

