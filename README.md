# SwingScan 🚀
### Self-Improving AI Swing Trade Watchlist

Powered by Claude AI. Gets smarter every time you add a stock manually.

---

## Deploy to Railway in 5 Minutes

### Step 1 — Push to GitHub
```bash
git init
git add .
git commit -m "Initial SwingScan"
git remote add origin https://github.com/YOUR_USERNAME/swingscan.git
git push -u origin main
```

### Step 2 — Deploy on Railway
1. Go to **railway.app** and sign in
2. Click **New Project → Deploy from GitHub repo**
3. Select your `swingscan` repo
4. Railway auto-detects Node.js — no config needed

### Step 3 — Set Environment Variable
In Railway dashboard → your project → **Variables** tab:
```
ANTHROPIC_API_KEY = sk-ant-your-key-here
```
Get your API key at: **console.anthropic.com**

### Step 4 — Done!
Railway gives you a URL like `swingscan-production.up.railway.app`

---

## How the Self-Improvement Works

Every time you manually add a stock:
1. Claude searches the web for info about that stock
2. Analyzes **why the scanner missed it** based on current criteria
3. Generates **1 new specific rule** to catch similar stocks next time
4. Updates `data/criteria.json` — the scanner is now smarter
5. Shows you a modal explaining exactly what was missed and why

The **Learning Log tab** shows:
- All rules the scanner has learned
- Every stock you added + why it was missed
- Confidence score for each missed stock as a swing trade

---

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/scan` | POST | Scan list of tickers for prices + Fib levels |
| `/api/trending` | POST | Get most active stocks by options volume |
| `/api/feedback` | POST | Analyze why a stock was missed + update criteria |
| `/api/criteria` | GET | Get current scanning criteria |
| `/api/learning-history` | GET | Get full learning log |
| `/api/criteria/reset` | POST | Reset criteria to defaults |
| `/api/health` | GET | Health check |

---

## Local Development

```bash
npm install
ANTHROPIC_API_KEY=sk-ant-xxx node server.js
# Open http://localhost:3000
```

---

## Tech Stack
- **Backend**: Node.js + Express
- **AI**: Anthropic Claude Sonnet with web search
- **Frontend**: Vanilla HTML/CSS/JS (no framework needed)
- **Storage**: JSON file (upgradeable to PostgreSQL)
- **Deploy**: Railway (or any Node.js host)
