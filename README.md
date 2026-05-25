# SwingScan

Self-improving AI swing-trading watchlist with macro regime overlay and mode classification.

## Features

- **Macro regime overlay**: Top banner classifying market into Healthy / Choppy / Correction / Distribution / Bear from SPY+QQQ
- **Mode classifier per stock**: Setup Forming / Setup Ready / Early Momentum / Established Momentum / Late Momentum / Trend Break
- **Mode-aware entry/target logic**: Fibonacci for setups, MA-pullback (9 EMA / 20 MA) for momentum
- **Auto news per stock** (Finnhub): last 5 days of headlines
- **Manual paste & extract**: paste WhatsApp/Telegram/news text, Claude extracts per-stock + macro items
- **9 EMA + 20 MA + 50 MA tracked together** on each card
- **Themed watchlist** with self-learning rules
- **Fibonacci retracement levels** (.500, .618) with stops + extension targets

## Environment Variables (Railway)

- `ANTHROPIC_API_KEY` (required) — Claude for extraction + feedback analysis
- `FINNHUB_API_KEY` (optional) — Auto news per stock. Free at finnhub.io
- `PORT` (auto-set by Railway)

## Local Dev

```
npm install
node server.js
# open http://localhost:3000
```

## File Structure

```
swingscan/
├── server.js              # Main Express server
├── services/
│   ├── regime.js          # SPY + QQQ regime classifier
│   ├── news.js            # Finnhub news integration
│   └── mode.js            # Setup vs momentum mode classifier
├── public/index.html      # Frontend
└── data/criteria.json     # Self-learning rules
```
