# Features / Ideas (parking lot)

This file is intentionally lightweight: it captures “good next ideas” without committing to implementation order.

## Stocks/equities workflow + morning check integration

- Strong use case for per-channel memory + scheduled tasks.
- Suggested minimal design (no external pricing yet):
  - In an equities channel, maintain a `## Watchlist` section (or a `watchlist.jsonl`) with:
    - `ticker`
    - `date`
    - “why I care” / user hypothesis
  - Morning check can scan managed channels for watchlist items and remind:
    - “3 follow-ups due today”
    - “2 items hit their ‘check again in 3 days’ horizon”
- Phase 2 (price movement + assessment) needs a reliable data source (API or scraping). Decide:
  - what source (and how to avoid flaky scraping)
  - how to store snapshots (so we can compare later)
  - how to phrase “assessment” safely (avoid overconfident financial advice)

