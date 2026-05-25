// services/mode.js — Mode classifier (Setup vs Momentum)
// Classifies each stock into one of 6 modes with different trading rules

function calcEMA(values, period) {
  if (values.length === 0) return 0;
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i-1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period, avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function findRecentBreakout(candles, lookback = 60) {
  // Find the most recent day where the stock decisively broke above 
  // the high of the prior 20 days
  const data = candles.slice(-lookback);
  for (let i = data.length - 1; i >= 20; i--) {
    const priorHigh = Math.max(...data.slice(i - 20, i).map(c => c.h));
    if (data[i].c > priorHigh * 1.02 && data[i].c > data[i].o) {
      // Breakout candle — return days ago
      return { 
        daysAgo: data.length - 1 - i, 
        breakoutLevel: priorHigh,
        breakoutPrice: data[i].c,
      };
    }
  }
  return null;
}

function classifyMode(candles, currentPrice, fibSwingHigh, fibSwingLow) {
  if (candles.length < 30) {
    return { mode: 'UNKNOWN', label: 'Insufficient data', action: 'Wait for more data', confidence: 0 };
  }
  
  const closes = candles.map(c => c.c);
  const last5 = candles.slice(-5);
  const last10 = candles.slice(-10);
  const last20 = candles.slice(-20);
  const prior10 = candles.slice(-20, -10);
  
  // Moving averages — 9 EMA, 20 SMA, 50 SMA
  const ema9 = calcEMA(closes.slice(-30), 9);
  const ma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const ma50 = closes.length >= 50 ? closes.slice(-50).reduce((a, b) => a + b, 0) / 50 : ma20;
  
  // Distance from MAs
  const distEma9 = ((currentPrice - ema9) / ema9) * 100;
  const distMa20 = ((currentPrice - ma20) / ma20) * 100;
  const distMa50 = ((currentPrice - ma50) / ma50) * 100;
  
  // RSI
  const rsi = calcRSI(closes);
  
  // Volume analysis
  const avgVol20 = last20.reduce((a, c) => a + (c.v || 0), 0) / 20;
  const recentVol5 = last5.reduce((a, c) => a + (c.v || 0), 0) / 5;
  const volRatio5_20 = avgVol20 > 0 ? recentVol5 / avgVol20 : 1;
  
  // 20-day consolidation box
  const consolHigh = Math.max(...last20.map(c => c.h));
  const consolLow = Math.min(...last20.map(c => c.l));
  const consolRangePct = consolLow > 0 ? ((consolHigh - consolLow) / consolLow) * 100 : 0;
  
  // Position above/below consolidation high
  const pctAboveConsol = consolHigh > 0 ? ((currentPrice - consolHigh) / consolHigh) * 100 : 0;
  
  // Fibonacci levels (where actual swing high/low are valid)
  const validFib = fibSwingHigh > fibSwingLow && fibSwingHigh > 0 && fibSwingLow > 0;
  const fibRange = validFib ? fibSwingHigh - fibSwingLow : 0;
  const fib50 = validFib ? fibSwingHigh - fibRange * 0.5 : 0;
  const fib618 = validFib ? fibSwingHigh - fibRange * 0.618 : 0;
  const fib382 = validFib ? fibSwingHigh - fibRange * 0.382 : 0;
  
  // Where current price sits in fib range (0 = at swing low, 1 = at swing high)
  const fibPosition = validFib ? (currentPrice - fibSwingLow) / (fibSwingHigh - fibSwingLow) : 0.5;
  
  // Volume contraction
  const recentVol10 = last10.reduce((a, c) => a + (c.v || 0), 0) / 10;
  const priorVol10 = prior10.reduce((a, c) => a + (c.v || 0), 0) / 10;
  const volDryPct = priorVol10 > 0 ? ((priorVol10 - recentVol10) / priorVol10) * 100 : 0;
  
  // Trend slope from 20MA — compare to 10 days ago
  const ma20_10ago = closes.slice(-30, -10).reduce((a, b) => a + b, 0) / 20;
  const ma20Slope = ((ma20 - ma20_10ago) / ma20_10ago) * 100;
  
  // Was there a recent breakout?
  const breakout = findRecentBreakout(candles, 60);
  const daysSinceBreakout = breakout?.daysAgo;
  const holdingBreakout = breakout && currentPrice > breakout.breakoutLevel;
  
  // Are MAs aligned bullishly?
  const bullishMA = currentPrice > ema9 && ema9 > ma20 && ma20 > ma50;
  const lostMa50 = currentPrice < ma50 && ma20 < ma50;
  
  // Build classification reasoning
  const facts = {
    rsi: +rsi.toFixed(1),
    ema9: +ema9.toFixed(2), ma20: +ma20.toFixed(2), ma50: +ma50.toFixed(2),
    distEma9: +distEma9.toFixed(2), distMa20: +distMa20.toFixed(2), distMa50: +distMa50.toFixed(2),
    consolHigh: +consolHigh.toFixed(2), consolLow: +consolLow.toFixed(2), consolRangePct: +consolRangePct.toFixed(1),
    pctAboveConsol: +pctAboveConsol.toFixed(1),
    daysSinceBreakout, holdingBreakout,
    volRatio5_20: +volRatio5_20.toFixed(2),
    volDryPct: +volDryPct.toFixed(1),
    ma20Slope: +ma20Slope.toFixed(2),
    fibPosition: +fibPosition.toFixed(2),
    fib50: +fib50.toFixed(2), fib618: +fib618.toFixed(2), fib382: +fib382.toFixed(2),
    bullishMA, lostMa50,
  };
  
  // === MODE CLASSIFICATION ===
  
  // 1. TREND BREAK: Lost the 50MA decisively on volume
  if (lostMa50 && distMa50 < -3 && volRatio5_20 > 1.2) {
    return {
      mode: 'TREND_BREAK',
      label: 'Trend Break',
      color: 'red',
      action: 'Exit / avoid. Wait for new base to form.',
      reasoning: `Lost 50MA by ${Math.abs(distMa50).toFixed(1)}% on ${volRatio5_20.toFixed(1)}× volume`,
      entryStrategy: null,
      facts, confidence: 80,
    };
  }
  
  // 2. LATE/EXHAUSTED MOMENTUM: Extended far from MAs, RSI extreme, climactic volume
  if (distMa20 > 18 && rsi > 75 && volRatio5_20 > 1.5) {
    return {
      mode: 'LATE_MOMENTUM',
      label: 'Late/Exhausted Momentum',
      color: 'orange',
      action: "Don't chase. Wait for cool-down to 20MA.",
      reasoning: `Extended ${distMa20.toFixed(0)}% above 20MA · RSI ${rsi.toFixed(0)} · vol ${volRatio5_20.toFixed(1)}× — climactic`,
      entryStrategy: { 
        type: 'pullback', 
        level: ma20, 
        levelLabel: '20MA',
        stopBelow: ma50,
        targetTrail: 'Trail 9EMA',
      },
      facts, confidence: 75,
    };
  }
  
  // 3. EARLY MOMENTUM: Recent breakout (5-15 days ago), holding above breakout, MAs aligned
  if (breakout && daysSinceBreakout >= 1 && daysSinceBreakout <= 15 && holdingBreakout && bullishMA) {
    return {
      mode: 'EARLY_MOMENTUM',
      label: 'Early Momentum',
      color: 'green',
      action: 'Momentum buy. Add on pullbacks to 9EMA or 20MA.',
      reasoning: `Broke out ${daysSinceBreakout} days ago, holding above $${breakout.breakoutLevel.toFixed(2)} · MAs aligned · RSI ${rsi.toFixed(0)}`,
      entryStrategy: {
        type: 'pullback',
        level: ema9,
        levelLabel: '9 EMA',
        levelSecondary: ma20,
        levelSecondaryLabel: '20 MA',
        stopBelow: ma20 * 0.97,
        targetTrail: 'Trail under 20MA',
      },
      facts, confidence: 85,
    };
  }
  
  // 4. ESTABLISHED MOMENTUM: Been trending 1-3 months, healthy MA structure
  if (bullishMA && distMa20 < 15 && distMa20 > 0 && ma20Slope > 1 && rsi >= 45 && rsi <= 75) {
    return {
      mode: 'ESTABLISHED_MOMENTUM',
      label: 'Established Momentum',
      color: 'green',
      action: 'Hold / trail. Pullback to 20MA = add.',
      reasoning: `Healthy uptrend · ${distMa20.toFixed(1)}% above 20MA · trend +${ma20Slope.toFixed(1)}% · RSI ${rsi.toFixed(0)}`,
      entryStrategy: {
        type: 'pullback',
        level: ma20,
        levelLabel: '20 MA',
        levelSecondary: ema9,
        levelSecondaryLabel: '9 EMA',
        stopBelow: ma50,
        targetTrail: 'Trail 20MA',
      },
      facts, confidence: 80,
    };
  }
  
  // 5. SETUP READY: Pulled back into fib zone (.500-.618), declining volume
  if (validFib && fibPosition >= 0.382 && fibPosition <= 0.62 && volDryPct > 5) {
    return {
      mode: 'SETUP_READY',
      label: 'Setup Ready',
      color: 'blue',
      action: `Enter on bounce. Fib zone ${fib618.toFixed(2)}–${fib50.toFixed(2)}.`,
      reasoning: `In .500–.618 fib zone · volume drying ${volDryPct.toFixed(0)}% · ready for bounce`,
      entryStrategy: {
        type: 'fib',
        levelBest: fib618,
        levelBestLabel: '.618 (best)',
        levelSafe: fib50,
        levelSafeLabel: '.500 (safe)',
        stopBelow: fib618 * 0.97,
        target1: currentPrice + (fibSwingHigh - fibSwingLow) * 0.5,
        target2: currentPrice + (fibSwingHigh - fibSwingLow),
      },
      facts, confidence: 75,
    };
  }
  
  // 6. SETUP FORMING: Tight base, low volume, in upper fib range but not at entry yet
  if (consolRangePct < 15 && volDryPct > 10) {
    return {
      mode: 'SETUP_FORMING',
      label: 'Setup Forming',
      color: 'purple',
      action: 'Wait — get ready. Tight base building.',
      reasoning: `Tight ${consolRangePct.toFixed(0)}% box · vol drying ${volDryPct.toFixed(0)}%`,
      entryStrategy: {
        type: 'breakout_or_pullback',
        breakoutLevel: consolHigh * 1.02,
        breakoutLabel: 'Breakout: 2% above box',
        pullbackLevel: validFib ? fib50 : ma20,
        pullbackLabel: validFib ? '.500 fib' : '20MA',
      },
      facts, confidence: 60,
    };
  }
  
  // 7. EXTENDED-BUT-NOT-LATE: Stock has run but not climactic yet
  if (distMa20 > 8 && distMa20 < 18 && rsi < 75) {
    return {
      mode: 'EARLY_MOMENTUM',
      label: 'Early Momentum (mild)',
      color: 'green',
      action: 'Wait for pullback to 9EMA or 20MA before entering.',
      reasoning: `${distMa20.toFixed(0)}% above 20MA · RSI ${rsi.toFixed(0)} · not climactic but extended`,
      entryStrategy: {
        type: 'pullback',
        level: ema9,
        levelLabel: '9 EMA',
        levelSecondary: ma20,
        levelSecondaryLabel: '20 MA',
        stopBelow: ma20 * 0.97,
      },
      facts, confidence: 65,
    };
  }
  
  // Default: WAIT — no clear mode
  return {
    mode: 'WAIT',
    label: 'No clear mode',
    color: 'gray',
    action: 'No actionable setup. Check back next week.',
    reasoning: `Mixed signals · RSI ${rsi.toFixed(0)} · ${distMa20.toFixed(1)}% from 20MA`,
    entryStrategy: null,
    facts, confidence: 40,
  };
}

// Apply macro regime context to modify the recommendation
function applyRegimeContext(modeResult, regime) {
  if (!regime || !modeResult) return modeResult;
  
  const r = regime.regime;
  const baseAction = modeResult.action;
  let adjustedAction = baseAction;
  let sizing = 'normal';
  
  if (r === 'HEALTHY') {
    if (modeResult.mode === 'EARLY_MOMENTUM' || modeResult.mode === 'ESTABLISHED_MOMENTUM') {
      adjustedAction = baseAction + ' · Full size in healthy regime.';
      sizing = 'full';
    } else if (modeResult.mode === 'SETUP_READY') {
      adjustedAction = baseAction + ' · Full size.';
      sizing = 'full';
    }
  } else if (r === 'CHOPPY' || r === 'NEUTRAL') {
    adjustedAction = baseAction + ' · Half size in choppy regime.';
    sizing = 'half';
  } else if (r === 'CORRECTION') {
    if (modeResult.mode === 'EARLY_MOMENTUM' || modeResult.mode === 'ESTABLISHED_MOMENTUM') {
      adjustedAction = 'Wait — corrections punish momentum entries. Look for setup pullbacks instead.';
      sizing = 'wait';
    } else {
      adjustedAction = baseAction + ' · Half size + hedge.';
      sizing = 'half';
    }
  } else if (r === 'DISTRIBUTION' || r === 'BEAR') {
    adjustedAction = 'AVOID new longs in this regime. Wait for confirmed base.';
    sizing = 'avoid';
  }
  
  return { ...modeResult, action: adjustedAction, sizing, regimeContext: r };
}

module.exports = { classifyMode, applyRegimeContext, calcEMA, calcRSI };
