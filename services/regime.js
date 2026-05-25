// services/regime.js — Macro market regime classifier
// Pulls SPY + QQQ daily data and classifies the market environment into 5 states

async function fetchDaily(ticker, range = '6mo') {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
  };
  const res = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=${range}`,
    { headers }
  );
  if (!res.ok) throw new Error(`Yahoo ${res.status} for ${ticker}`);
  const json = await res.json();
  const r = json.chart?.result?.[0];
  if (!r) throw new Error(`No data for ${ticker}`);
  const q = r.indicators.quote[0];
  return q.close.map((c, i) => ({
    c, h: q.high[i], l: q.low[i], v: q.volume[i], o: q.open[i],
  })).filter(x => x.c != null && x.h != null && x.l != null && x.c > 0 && isFinite(x.c));
}

function ema(values, period) {
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function sma(values, period) {
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function analyzeIndex(candles, name) {
  if (candles.length < 50) return null;
  const closes = candles.map(c => c.c);
  const price = closes[closes.length - 1];
  
  // Moving averages — including 9 EMA
  const ema9 = ema(closes.slice(-30), 9);
  const ma20 = sma(closes, 20);
  const ma50 = sma(closes, 50);
  const ma100 = closes.length >= 100 ? sma(closes, 100) : ma50;
  const ma200 = closes.length >= 200 ? sma(closes, 200) : ma100;
  
  // Distance from MAs (%)
  const distMa20 = ((price - ma20) / ma20) * 100;
  const distMa50 = ((price - ma50) / ma50) * 100;
  const distMa200 = ((price - ma200) / ma200) * 100;
  
  // Recent high (last 60 days)
  const recent = closes.slice(-60);
  const recentHigh = Math.max(...recent);
  const pullbackPct = ((recentHigh - price) / recentHigh) * 100;
  
  // Days since last 2%+ down day
  let daysSinceBigDown = 0;
  for (let i = closes.length - 1; i > Math.max(0, closes.length - 60); i--) {
    const chg = (closes[i] - closes[i-1]) / closes[i-1] * 100;
    if (chg <= -2) break;
    daysSinceBigDown++;
  }
  
  // Trend slope: 20MA today vs 20MA 10 days ago
  const ma20_10ago = sma(closes.slice(0, -10), 20);
  const slopePct = ((ma20 - ma20_10ago) / ma20_10ago) * 100;
  
  // Above-MA conditions
  const aboveAll = price > ma20 && price > ma50 && price > ma200;
  const below200 = price < ma200;
  const below50 = price < ma50;
  
  // Recent volatility — % of last 10 days that closed down >1%
  const last10 = closes.slice(-11);
  let bigDownDays = 0;
  for (let i = 1; i < last10.length; i++) {
    if ((last10[i] - last10[i-1]) / last10[i-1] * 100 < -1) bigDownDays++;
  }
  
  return {
    name, price: +price.toFixed(2),
    ema9: +ema9.toFixed(2), ma20: +ma20.toFixed(2), ma50: +ma50.toFixed(2), 
    ma100: +ma100.toFixed(2), ma200: +ma200.toFixed(2),
    distMa20: +distMa20.toFixed(2), distMa50: +distMa50.toFixed(2), distMa200: +distMa200.toFixed(2),
    pullbackPct: +pullbackPct.toFixed(2),
    daysSinceBigDown,
    slopePct: +slopePct.toFixed(2),
    aboveAll, below200, below50,
    bigDownDays,
  };
}

function classifyRegime(spy, qqq) {
  if (!spy || !qqq) return { regime: 'UNKNOWN', label: 'Data unavailable', color: 'gray', action: 'Check data sources' };
  
  // BEAR: Either index below 200MA with downtrend
  if ((spy.below200 || qqq.below200) && (spy.slopePct < -1 || qqq.slopePct < -1)) {
    return {
      regime: 'BEAR',
      label: 'Bear / Risk-Off',
      color: 'red',
      action: 'Minimal long exposure. Momentum shorts. Raise cash. Hedges on.',
      detail: `Below 200MA · downtrend · SPY ${spy.distMa200>=0?'+':''}${spy.distMa200}% from 200MA · QQQ ${qqq.distMa200>=0?'+':''}${qqq.distMa200}%`,
    };
  }
  
  // DISTRIBUTION: Multiple big down days recently + key MAs broken on volume
  if ((spy.bigDownDays >= 3 || qqq.bigDownDays >= 3) && (spy.below50 || qqq.below50)) {
    return {
      regime: 'DISTRIBUTION',
      label: 'Distribution / Topping',
      color: 'red',
      action: 'Heavy hedges. Exit weak holdings. Raise cash. Wait for confirmed support.',
      detail: `${Math.max(spy.bigDownDays, qqq.bigDownDays)} big down days in last 10 · 50MA broken`,
    };
  }
  
  // CORRECTION: Lost 50MA, sitting on 100/200MA
  if ((spy.below50 || qqq.below50) && spy.pullbackPct > 8) {
    return {
      regime: 'CORRECTION',
      label: 'Deeper Correction',
      color: 'orange',
      action: 'Wait for deeper pullbacks (.618 entries). Half size. Build hedges.',
      detail: `Pullback ${spy.pullbackPct}% from recent high · below 50MA`,
    };
  }
  
  // CHOPPY: Between 20MA and 50MA, no clear direction
  if (Math.abs(spy.distMa20) < 1 && Math.abs(qqq.distMa20) < 1 && Math.abs(spy.slopePct) < 0.5) {
    return {
      regime: 'CHOPPY',
      label: 'Choppy / Range-Bound',
      color: 'yellow',
      action: 'Smaller size. Wait for clearer setups. Partial hedges.',
      detail: `Both indices near 20MA · trend slope flat ${spy.slopePct}%`,
    };
  }
  
  // HEALTHY: Both above 20MA and 50MA, trend rising, shallow pullbacks
  if (spy.aboveAll && qqq.aboveAll && spy.slopePct > 0 && spy.pullbackPct < 5) {
    return {
      regime: 'HEALTHY',
      label: 'Healthy / Shallow-Dip',
      color: 'green',
      action: 'Buy dips full size. Minimal hedges. Momentum plays favored.',
      detail: `Both above all MAs · pullback only ${spy.pullbackPct}% · trend +${spy.slopePct}%`,
    };
  }
  
  // Default: mildly healthy
  return {
    regime: 'NEUTRAL',
    label: 'Neutral / Slight Caution',
    color: 'yellow',
    action: 'Normal sizing. Be selective with new entries.',
    detail: `SPY ${spy.distMa20>=0?'+':''}${spy.distMa20}% from 20MA · pullback ${spy.pullbackPct}%`,
  };
}

async function getMarketRegime() {
  try {
    const [spyCandles, qqqCandles] = await Promise.all([
      fetchDaily('SPY', '1y'),
      fetchDaily('QQQ', '1y'),
    ]);
    
    const spy = analyzeIndex(spyCandles, 'SPY');
    const qqq = analyzeIndex(qqqCandles, 'QQQ');
    const classification = classifyRegime(spy, qqq);
    
    return {
      ...classification,
      spy, qqq,
      timestamp: new Date().toISOString(),
    };
  } catch(e) {
    console.error('Regime detection error:', e.message);
    return {
      regime: 'UNKNOWN',
      label: 'Data unavailable',
      color: 'gray',
      action: 'Check connection',
      detail: e.message,
      error: e.message,
    };
  }
}

module.exports = { getMarketRegime, fetchDaily };
