const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

// ── ANTHROPIC CLIENT ──
const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ── CRITERIA ENGINE ──
const CRITERIA_FILE = path.join(__dirname, 'data', 'criteria.json');

const DEFAULT_CRITERIA = {
  version: 1,
  lastUpdated: new Date().toISOString().split('T')[0],
  rules: [
    "Focus on stocks with significant price swings (>20%) in the past 6 months",
    "Prioritize stocks in strong uptrends that have pulled back to Fibonacci support (0.5-0.618)",
    "Look for unusual options volume spikes (2x or more above 30-day average)",
    "Include stocks with upcoming catalysts: earnings, product launches, government contracts",
    "Target themes: AI, semiconductors, defense, space, robotics, voice AI, crypto, EV, energy, biotech",
  ],
  learnedPatterns: [],
  missedStocks: [],
  themeExpansions: {},
};

function loadCriteria() {
  try {
    if (fs.existsSync(CRITERIA_FILE)) {
      return JSON.parse(fs.readFileSync(CRITERIA_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to load criteria:', e.message);
  }
  return { ...DEFAULT_CRITERIA };
}

function saveCriteria(criteria) {
  try {
    const dir = path.dirname(CRITERIA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    criteria.lastUpdated = new Date().toISOString().split('T')[0];
    fs.writeFileSync(CRITERIA_FILE, JSON.stringify(criteria, null, 2));
    console.log(`✅ Criteria updated to v${criteria.version}`);
  } catch (e) {
    console.error('Failed to save criteria:', e.message);
  }
}

// ── CLAUDE API HELPER ──
async function askClaude(prompt, maxTokens = 1000) {
  const msg = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: maxTokens,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    messages: [{ role: 'user', content: prompt }],
  });
  return msg.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

function extractJSON(text, type = 'array') {
  const clean = text.replace(/```json?/gi, '').replace(/```/g, '').trim();
  const pattern = type === 'array' ? /\[[\s\S]*\]/ : /\{[\s\S]*\}/;
  const match = clean.match(pattern);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch (e) {
    return null;
  }
}

// ── ROUTES ──

// Health check
app.get('/api/health', (req, res) => {
  const criteria = loadCriteria();
  res.json({
    status: 'ok',
    criteriaVersion: criteria.version,
    learnedPatterns: criteria.learnedPatterns.length,
    lastUpdated: criteria.lastUpdated,
  });
});

// Get current criteria
app.get('/api/criteria', (req, res) => {
  res.json(loadCriteria());
});

// Scan stocks — fetch real prices and calculate Fibonacci levels
app.post('/api/scan', async (req, res) => {
  const { tickers } = req.body;
  if (!tickers || !tickers.length) {
    return res.status(400).json({ error: 'No tickers provided' });
  }

  const criteria = loadCriteria();
  const batches = [];
  for (let i = 0; i < tickers.length; i += 8) {
    batches.push(tickers.slice(i, i + 8));
  }

  const allData = [];

  for (const batch of batches) {
    const prompt = `Search for current stock market data for these tickers: ${batch.join(', ')}

Current scanning criteria being used:
${criteria.rules.join('\n')}

For each ticker return current price, today's % change, 52-week high, 52-week low, and company name.
Return ONLY a JSON array, no markdown, no backticks, no explanation:
[{"ticker":"NVDA","name":"NVIDIA Corp","price":135.50,"changePct":2.3,"high52":180.0,"low52":80.0}]
If a ticker is invalid or delisted, skip it.`;

    try {
      const raw = await askClaude(prompt);
      const parsed = extractJSON(raw, 'array');
      if (parsed) {
        parsed
          .filter((s) => s && s.ticker && s.price && s.high52 && s.low52)
          .forEach((s) => allData.push(s));
      }
    } catch (e) {
      console.error(`Batch error for ${batch}:`, e.message);
    }
  }

  res.json({ stocks: allData, criteriaVersion: criteria.version });
});

// Most Active — options volume + momentum + squeeze scoring
app.post('/api/trending', async (req, res) => {
  const criteria = loadCriteria();

  const prompt = `Find the 20 most actively traded US stocks RIGHT NOW based on:
- Unusual options volume (calls and puts significantly above average)
- High put/call ratio or extreme bullish call buying  
- Strong price momentum this week
- Short squeeze potential (high short interest + rising price)
- Recent news catalysts

Current learned criteria that matter to this trader:
${criteria.learnedPatterns.length > 0 ? criteria.learnedPatterns.join('\n') : 'Standard momentum and options activity'}

For each stock calculate a composite activity score 0-100:
- Options volume spike vs 30-day avg: 35% of score
- Price momentum this week: 25% of score
- Stock volume vs average: 25% of score  
- Short squeeze/IV signal: 15% of score

Return ONLY a JSON array, no markdown:
[{"ticker":"NVDA","name":"NVIDIA Corp","price":135.50,"changePct":2.3,"optScore":85,"momScore":70,"volScore":65,"ivScore":55,"composite":74,"pcRatio":"0.7","sentiment":"heavy call buying","reason":"Computex keynote + earnings beat","catalysts":["Jensen keynote June 1","Q1 earnings beat"]}]
Sort by composite score descending.`;

  try {
    const raw = await askClaude(prompt, 1500);
    const parsed = extractJSON(raw, 'array');
    res.json({ stocks: parsed || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Feedback — self-improvement when user adds a stock manually
app.post('/api/feedback', async (req, res) => {
  const { ticker, theme } = req.body;
  if (!ticker) return res.status(400).json({ error: 'No ticker provided' });

  const criteria = loadCriteria();

  const prompt = `A swing trader manually added the stock ticker "${ticker}" to their "${theme}" watchlist category.

This means our scanner MISSED this stock. The current scanning criteria was:
${criteria.rules.map((r, i) => `${i + 1}. ${r}`).join('\n')}

Previously learned patterns:
${criteria.learnedPatterns.length > 0 ? criteria.learnedPatterns.join('\n') : 'None yet'}

Please:
1. Search for current information about ${ticker} — what is this company, what sector, what's been happening with it?
2. Analyze WHY the current criteria would have missed it (be specific and honest)
3. Write ONE new specific rule to add to the scanning criteria to catch stocks like this in future scans
4. Rate this stock as a swing trade opportunity right now (0-100 confidence)
5. List 2-3 key catalysts or reasons this stock is interesting

Return ONLY this JSON object, no markdown:
{
  "ticker": "${ticker}",
  "companyName": "Full company name",
  "sector": "Sector name",
  "currentPrice": 0.00,
  "missedReason": "2-3 sentence explanation of exactly why our scanner missed this stock",
  "newRule": "Specific new rule to add to scanning criteria",
  "stockSummary": "2 sentence summary of what this company does and why it's interesting for swing trading",
  "confidence": 75,
  "catalysts": ["catalyst 1", "catalyst 2"],
  "themeRecommendation": "Best theme this stock fits into"
}`;

  try {
    const raw = await askClaude(prompt, 1200);
    const feedback = extractJSON(raw, 'object');

    if (feedback && feedback.newRule) {
      // Update criteria with the learning
      const newRule = feedback.newRule.trim();
      const alreadyExists = criteria.rules.some(
        (r) => r.toLowerCase().includes(newRule.toLowerCase().substring(0, 30))
      );

      if (!alreadyExists) {
        criteria.rules.push(newRule);
        criteria.learnedPatterns.push(
          `[v${criteria.version + 1}] Added after user added ${ticker}: ${newRule}`
        );
        criteria.missedStocks.push({
          ticker,
          theme,
          addedAt: new Date().toISOString(),
          missedReason: feedback.missedReason,
          newRule,
        });
        criteria.version++;
        saveCriteria(criteria);
      }

      res.json({
        ...feedback,
        criteriaUpdated: !alreadyExists,
        newCriteriaVersion: criteria.version,
      });
    } else {
      res.json({
        ticker,
        missedReason: 'Could not analyze why this stock was missed.',
        newRule: null,
        criteriaUpdated: false,
      });
    }
  } catch (e) {
    console.error('Feedback error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Get history of missed stocks + what was learned
app.get('/api/learning-history', (req, res) => {
  const criteria = loadCriteria();
  res.json({
    version: criteria.version,
    totalRulesLearned: criteria.learnedPatterns.length,
    missedStocksAnalyzed: criteria.missedStocks || [],
    currentRules: criteria.rules,
    learnedPatterns: criteria.learnedPatterns,
  });
});

// Reset criteria to defaults
app.post('/api/criteria/reset', (req, res) => {
  saveCriteria({ ...DEFAULT_CRITERIA });
  res.json({ message: 'Criteria reset to defaults', version: 1 });
});

// Start server
app.listen(PORT, () => {
  console.log(`
  ╔═══════════════════════════════════╗
  ║   SwingScan is running! 🚀        ║
  ║   Port: ${PORT}                      ║
  ║   Criteria v${loadCriteria().version}                     ║
  ╚═══════════════════════════════════╝
  `);
});
