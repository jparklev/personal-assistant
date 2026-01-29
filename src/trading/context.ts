import { listOpenTrades, listWatchedAssets, readTradingClaudeIntro } from './files';

export function buildTradingContext(vaultPath: string): string {
  const parts: string[] = [];

  const claudeIntro = readTradingClaudeIntro(vaultPath, 50).trim();
  if (claudeIntro) {
    parts.push(`## Trading/Claude.md (intro)\n\n${claudeIntro}`);
  }

  const openTrades = listOpenTrades(vaultPath, 10);
  if (openTrades.length > 0) {
    parts.push(
      [
        '## Open Trades (summary)',
        '',
        ...openTrades.map((t) => {
          const bits = [
            t.symbol ? `symbol: ${t.symbol}` : null,
            t.direction ? `dir: ${t.direction}` : null,
            t.entry ? `entry: ${t.entry}` : null,
          ].filter(Boolean);
          return `- ${t.title}${bits.length > 0 ? ` (${bits.join(', ')})` : ''}`;
        }),
      ].join('\n')
    );
  }

  const assets = listWatchedAssets(vaultPath, 12);
  if (assets.length > 0) {
    parts.push(
      [
        '## Watchlist (Ideas.md summary)',
        '',
        ...assets.map((a) => `- ${a.asset}${a.thesis ? ` — ${a.thesis}` : ''}`),
      ].join('\n')
    );
  }

  return parts.join('\n\n');
}

