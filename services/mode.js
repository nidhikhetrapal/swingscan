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

// Helper to build a rule checklist: each rule item is { label, satisfied, detail }
function ruleItem(label, satisfied, detail) {
  return { label, satisfied: !!satisfied, detail };
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
  
  // Moving averages — 9 EMA, 21 EMA (NEW — trend break warning), 20 SMA, 50 SMA
  const ema9 = calcEMA(closes.slice(-40), 9);
  const ema21 = calcEMA(closes.slice(-60), 21);  // Faster than 20 SMA — earlier trend-break signal
  const ma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const ma50 = closes.length >= 50 ? closes.slice(-50).reduce((a, b) => a + b, 0) / 50 : ma20;
  
  // Distance from MAs (%)
  const distEma9 = ((currentPrice - ema9) / ema9) * 100;
  const distEma21 = ((currentPrice - ema21) / ema21) * 100;
  const distMa20 = ((currentPrice - ma20) / ma20) * 100;
  const distMa50 = ((currentPrice - ma50) / ma50) * 100;
  
  // RSI
  const rsi = calcRSI(closes);
  
  // Volume
  const avgVol20 = last20.reduce((a, c) => a + (c.v || 0), 0) / 20;
  const recentVol5 = last5.reduce((a, c) => a + (c.v || 0), 0) / 5;
  const volRatio5_20 = avgVol20 > 0 ? recentVol5 / avgVol20 : 1;
  const recentVol10 = last10.reduce((a, c) => a + (c.v || 0), 0) / 10;
  const priorVol10 = prior10.reduce((a, c) => a + (c.v || 0), 0) / 10;
  const volDryPct = priorVol10 > 0 ? ((priorVol10 - recentVol10) / priorVol10) * 100 : 0;
  
  // Consolidation box (20-day)
  const consolHigh = Math.max(...last20.map(c => c.h));
  const consolLow = Math.min(...last20.map(c => c.l));
  const consolRangePct = consolLow > 0 ? ((consolHigh - consolLow) / consolLow) * 100 : 0;
  
  // Fibonacci levels
  const validFib = fibSwingHigh > fibSwingLow && fibSwingHigh > 0 && fibSwingLow > 0;
  const fibRange = validFib ? fibSwingHigh - fibSwingLow : 0;
  const fib50 = validFib ? fibSwingHigh - fibRange * 0.5 : 0;
  const fib618 = validFib ? fibSwingHigh - fibRange * 0.618 : 0;
  const fibPosition = validFib ? (currentPrice - fibSwingLow) / (fibSwingHigh - fibSwingLow) : 0.5;
  
  // 20MA trend slope (last 10 days)
  const ma20_10ago = closes.slice(-30, -10).reduce((a, b) => a + b, 0) / 20;
  const ma20Slope = ((ma20 - ma20_10ago) / ma20_10ago) * 100;
  
  // MA STRUCTURE — KEY checks for momentum and trend health
  const aboveEma9 = currentPrice > ema9;
  const aboveEma21 = currentPrice > ema21;
  const aboveMA20 = currentPrice > ma20;
  const aboveMA50 = currentPrice > ma50;
  
  // Trend slope on 21 EMA (faster signal than 20 SMA slope)
  const ema21_10ago = calcEMA(closes.slice(-70, -10), 21);
  const ema21Slope = ((ema21 - ema21_10ago) / ema21_10ago) * 100;
  
  // Bullish structure: above 9EMA, 21 EMA above MA20, MA20 above MA50
  const bullishMA = aboveEma9 && ema21 > ma20 * 0.99 && ma20 > ma50;
  
  // TREND BREAK SIGNALS — using 21 EMA as primary warning
  const lostEma21 = !aboveEma21 && ema21Slope < 0;   // closed below 21 EMA AND slope rolling over
  const nearEma21Break = aboveEma21 && distEma21 < 1 && ema21Slope < 0.3;  // bouncing on 21EMA with weakening slope
  const lostMa50 = !aboveMA50 && ma20 < ma50;  // deeper break — already in trouble
  
  // Recent breakout check
  const breakout = findRecentBreakout(candles, 60);
  
  // Facts object
  const facts = {
    rsi: +rsi.toFixed(1),
    ema9: +ema9.toFixed(2), ema21: +ema21.toFixed(2), ma20: +ma20.toFixed(2), ma50: +ma50.toFixed(2),
    distEma9: +distEma9.toFixed(2), distEma21: +distEma21.toFixed(2), distMa20: +distMa20.toFixed(2), distMa50: +distMa50.toFixed(2),
    ema21Slope: +ema21Slope.toFixed(2),
    consolHigh: +consolHigh.toFixed(2), consolLow: +consolLow.toFixed(2), consolRangePct: +consolRangePct.toFixed(1),
    daysSinceBreakout: breakout?.daysAgo,
    holdingBreakout: breakout && currentPrice > breakout.breakoutLevel,
    volRatio5_20: +volRatio5_20.toFixed(2),
    volDryPct: +volDryPct.toFixed(1),
    ma20Slope: +ma20Slope.toFixed(2),
    fibPosition: +fibPosition.toFixed(2),
    fib50: +fib50.toFixed(2), fib618: +fib618.toFixed(2),
    bullishMA, lostEma21, lostMa50,
  };

  // ═══════════════════════════════════════════════════════════════════
  // CLASSIFICATION — PRIORITY ORDER
  // 1. Check if BROKEN first (trend reversal)
  // 2. Then check MOMENTUM (uptrend present)
  //    - sub-classify by extension + RSI
  // 3. Then check SETUP modes (no uptrend, basing/pullback)
  // ═══════════════════════════════════════════════════════════════════
  
  // ── 1. TREND BREAK (using 21 EMA as primary trigger — earlier than 50MA) ──
  // Major break: lost 50MA + downtrend — already deep in trouble
  if (lostMa50 && distMa50 < -3 && volRatio5_20 > 1.2) {
    return {
      mode: 'TREND_BREAK',
      label: 'Trend Break — Major',
      color: 'red',
      action: 'Exit / avoid. Trend is broken. Wait for new base.',
      reasoning: `Lost 50MA by ${Math.abs(distMa50).toFixed(1)}% on ${volRatio5_20.toFixed(1)}× volume · 21 EMA also broken`,
      ruleChecklist: [
        ruleItem('Price below 50 MA', !aboveMA50, `$${currentPrice.toFixed(2)} vs 50MA $${ma50.toFixed(2)}`),
        ruleItem('20 MA below 50 MA (bearish cross)', ma20 < ma50, `20MA $${ma20.toFixed(2)} vs 50MA $${ma50.toFixed(2)}`),
        ruleItem('More than 3% below 50 MA', distMa50 < -3, `${distMa50.toFixed(1)}% from 50MA`),
        ruleItem('Volume > 1.2× average (selling pressure)', volRatio5_20 > 1.2, `${volRatio5_20.toFixed(2)}× vol`),
      ],
      entryStrategy: null,
      facts, confidence: 85,
    };
  }
  
  // Early break: lost 21 EMA on volume, slope rolling over
  if (lostEma21 && distEma21 < -2 && volRatio5_20 > 1.2) {
    return {
      mode: 'TREND_BREAK',
      label: 'Trend Break — Early Warning',
      color: 'red',
      action: 'Lost 21 EMA on volume. Cut size or exit. 50MA next support.',
      reasoning: `Lost 21 EMA by ${Math.abs(distEma21).toFixed(1)}% · 21EMA slope ${ema21Slope.toFixed(1)}%/10d · vol ${volRatio5_20.toFixed(1)}×`,
      ruleChecklist: [
        ruleItem('Price below 21 EMA', !aboveEma21, `$${currentPrice.toFixed(2)} vs 21EMA $${ema21.toFixed(2)}`),
        ruleItem('21 EMA slope rolling over (negative)', ema21Slope < 0, `${ema21Slope.toFixed(2)}%/10d`),
        ruleItem('More than 2% below 21 EMA', distEma21 < -2, `${distEma21.toFixed(1)}% below`),
        ruleItem('Volume > 1.2× average', volRatio5_20 > 1.2, `${volRatio5_20.toFixed(2)}× vol`),
      ],
      entryStrategy: {
        type: 'exit',
        stopBelow: ma50,
        stopLabel: '50 MA (deeper support)',
      },
      facts, confidence: 80,
    };
  }
  
  // ── 2. MOMENTUM CHECK ──
  // A stock is in MOMENTUM if MAs are aligned bullishly AND price above 20MA AND trend rising
  const inMomentum = bullishMA && aboveMA20 && ma20Slope > 0;
  
  if (inMomentum) {
    // Build informational "watchout" tags — RSI extreme is INFO, not a gate
    const watchouts = [];
    if (rsi > 80) watchouts.push(`RSI ${rsi.toFixed(0)} — extended, but can stay this high in strong trends`);
    else if (rsi > 70) watchouts.push(`RSI ${rsi.toFixed(0)} — elevated`);
    if (volRatio5_20 > 2.0) watchouts.push(`Volume ${volRatio5_20.toFixed(1)}× — climactic`);
    
    // Calculate extension targets for momentum trades
    // Use fib swing range as the projection unit. If invalid, use 20-day range as fallback.
    const baseLow = validFib ? fibSwingLow : Math.min(...candles.slice(-60).map(c => c.l));
    const baseHigh = validFib ? fibSwingHigh : Math.max(...candles.slice(-60).map(c => c.h));
    const baseRange = baseHigh - baseLow;
    const target1_5x = baseLow + baseRange * 1.5;   // 1.5× extension
    const target2x = baseLow + baseRange * 2.0;     // 2× extension
    const target2_618x = baseLow + baseRange * 2.618; // golden ratio
    
    // Filter targets to only show ones above current price (others already hit)
    const momTargets = {
      target1_5x: target1_5x > currentPrice ? target1_5x : null,
      target2x: target2x > currentPrice ? target2x : null,
      target2_618x: target2_618x > currentPrice ? target2_618x : null,
      // Show % upside from current
      target1_5x_up: target1_5x > currentPrice ? ((target1_5x - currentPrice) / currentPrice * 100) : null,
      target2x_up: target2x > currentPrice ? ((target2x - currentPrice) / currentPrice * 100) : null,
      target2_618x_up: target2_618x > currentPrice ? ((target2_618x - currentPrice) / currentPrice * 100) : null,
    };
    
    // ── CLASSIFICATION BASED ON MA STRUCTURE + EXTENSION ONLY ──
    
    // LATE/EXHAUSTED MOMENTUM: very far from 20MA OR climactic volume on extended move
    if (distMa20 > 25 || (distMa20 > 15 && volRatio5_20 > 2.5)) {
      return {
        mode: 'LATE_MOMENTUM',
        label: 'Late/Exhausted Momentum',
        color: 'orange',
        action: "Don't chase. Wait for pullback to 9EMA or 21EMA.",
        reasoning: `Extended ${distMa20.toFixed(0)}% above 20MA · vol ${volRatio5_20.toFixed(1)}× — climactic structure`,
        ruleChecklist: [
          ruleItem('In momentum (bullish MAs + above 20MA + rising trend)', inMomentum, `bullishMA=${bullishMA}, above20MA=${aboveMA20}, slope=${ma20Slope.toFixed(2)}%`),
          ruleItem('OPTION A: 25%+ above 20 MA', distMa20 > 25, `${distMa20.toFixed(1)}% above 20MA (need >25)`),
          ruleItem('OPTION B: 15%+ above 20 MA AND vol > 2.5×', distMa20 > 15 && volRatio5_20 > 2.5, `${distMa20.toFixed(1)}% extension, ${volRatio5_20.toFixed(2)}× vol`),
        ],
        watchouts,
        entryStrategy: {
          type: 'pullback',
          level: ema9, levelLabel: '9 EMA',
          levelSecondary: ema21, levelSecondaryLabel: '21 EMA (preferred)',
          stopBelow: ema21 * 0.97,
          stopLabel: 'Below 21 EMA',
          targetTrail: 'Trail under 9EMA',
          ...momTargets,
        },
        facts, confidence: 80,
      };
    }
    
    // EXTENDED MOMENTUM: 10-25% above 20MA — structure intact, just don't chase
    if (distMa20 > 10) {
      return {
        mode: 'EARLY_MOMENTUM',
        label: 'Extended Momentum',
        color: 'orange',
        action: `Don't chase here. Wait for pullback to 9EMA $${ema9.toFixed(2)} or 21EMA $${ema21.toFixed(2)}.`,
        reasoning: `${distMa20.toFixed(1)}% above 20MA · MAs aligned · trend +${ma20Slope.toFixed(1)}%/10d`,
        ruleChecklist: [
          ruleItem('In momentum (bullish MAs + above 20MA + rising trend)', inMomentum, `bullishMA=${bullishMA}, above20MA=${aboveMA20}, slope=${ma20Slope.toFixed(2)}%`),
          ruleItem('10-25% above 20 MA (extended but not climactic)', distMa20 > 10 && distMa20 <= 25, `${distMa20.toFixed(1)}% above 20MA`),
          ruleItem('NOT climactic volume (otherwise → Late)', !(distMa20 > 15 && volRatio5_20 > 2.5), `${volRatio5_20.toFixed(2)}× vol`),
        ],
        watchouts,
        entryStrategy: {
          type: 'pullback',
          level: ema9, levelLabel: '9 EMA',
          levelSecondary: ema21, levelSecondaryLabel: '21 EMA',
          stopBelow: ema21 * 0.97,
          stopLabel: 'Below 21 EMA',
          targetTrail: 'Trail under 21 EMA (exit on break)',
          ...momTargets,
        },
        facts, confidence: 80,
      };
    }
    
    // FRESH BREAKOUT: broke out recently
    if (breakout && breakout.daysAgo <= 15 && currentPrice > breakout.breakoutLevel) {
      return {
        mode: 'EARLY_MOMENTUM',
        label: 'Early Momentum (fresh breakout)',
        color: 'green',
        action: `Momentum buy. Broke out ${breakout.daysAgo} days ago at $${breakout.breakoutLevel.toFixed(2)} — add on pullbacks to 9EMA.`,
        reasoning: `Fresh breakout · ${distMa20.toFixed(1)}% above 20MA · MAs aligned`,
        ruleChecklist: [
          ruleItem('In momentum (bullish MAs + above 20MA + rising trend)', inMomentum, `bullishMA=${bullishMA}, above20MA=${aboveMA20}, slope=${ma20Slope.toFixed(2)}%`),
          ruleItem('Broke out within last 15 days', breakout && breakout.daysAgo <= 15, breakout ? `${breakout.daysAgo} days ago at $${breakout.breakoutLevel.toFixed(2)}` : 'no recent breakout'),
          ruleItem('Holding above breakout level', breakout && currentPrice > breakout.breakoutLevel, breakout ? `$${currentPrice.toFixed(2)} vs $${breakout.breakoutLevel.toFixed(2)}` : '—'),
          ruleItem('NOT extended (< 10% above 20 MA)', distMa20 <= 10, `${distMa20.toFixed(1)}% above 20MA`),
        ],
        watchouts,
        entryStrategy: {
          type: 'pullback',
          level: ema9, levelLabel: '9 EMA',
          levelSecondary: ema21, levelSecondaryLabel: '21 EMA',
          stopBelow: ema21 * 0.97,
          stopLabel: 'Below 21 EMA',
          targetTrail: 'Exit on 21 EMA break',
          ...momTargets,
        },
        facts, confidence: 85,
      };
    }
    
    // ESTABLISHED MOMENTUM: in uptrend, less than 10% above 20MA — healthy spot
    return {
      mode: 'ESTABLISHED_MOMENTUM',
      label: 'Established Momentum',
      color: 'green',
      action: distEma9 < 2 
        ? `Buy here near 9EMA $${ema9.toFixed(2)}. Add on pullback to 21EMA $${ema21.toFixed(2)}.`
        : `Hold / trail. Add on pullback to 9EMA $${ema9.toFixed(2)} or 21EMA $${ema21.toFixed(2)}.`,
      reasoning: `Healthy uptrend · ${distMa20.toFixed(1)}% above 20MA · trend +${ma20Slope.toFixed(1)}%/10d`,
      ruleChecklist: [
        ruleItem('In momentum: bullish MA alignment (9EMA > 21EMA > 20MA > 50MA)', bullishMA, `9EMA $${ema9.toFixed(2)} | 21EMA $${ema21.toFixed(2)} | 20MA $${ma20.toFixed(2)} | 50MA $${ma50.toFixed(2)}`),
        ruleItem('Price above 20 MA', aboveMA20, `$${currentPrice.toFixed(2)} vs 20MA $${ma20.toFixed(2)}`),
        ruleItem('20 MA rising (slope > 0)', ma20Slope > 0, `${ma20Slope.toFixed(2)}%/10d`),
        ruleItem('NOT extended (< 10% above 20 MA)', distMa20 <= 10, `${distMa20.toFixed(1)}% above 20MA (need ≤10)`),
        ruleItem('NOT fresh breakout (otherwise → Early Momentum)', !(breakout && breakout.daysAgo <= 15), breakout ? `last breakout ${breakout.daysAgo} days ago` : 'no recent breakout'),
      ],
      watchouts: [...watchouts, ...(nearEma21Break ? [`Watch 21 EMA $${ema21.toFixed(2)} — bouncing on it now, break = exit signal`] : [])],
      entryStrategy: {
        type: 'pullback',
        level: ema9, levelLabel: '9 EMA',
        levelSecondary: ema21, levelSecondaryLabel: '21 EMA',
        stopBelow: ema21 * 0.97,
        stopLabel: 'Below 21 EMA (trend-break warning)',
        targetTrail: 'Trail under 21 EMA',
        ...momTargets,
      },
      facts, confidence: 85,
    };
  }
  
  // ── 3. SETUP MODES (not in momentum, no uptrend yet) ──
  
  // SETUP READY: pulled back into fib zone with declining volume
  if (validFib && fibPosition >= 0.382 && fibPosition <= 0.62 && volDryPct > 5) {
    return {
      mode: 'SETUP_READY',
      label: 'Setup Ready',
      color: 'blue',
      action: `Enter on bounce. Fib zone $${fib618.toFixed(2)}-$${fib50.toFixed(2)}.`,
      reasoning: `In .500-.618 fib zone · volume drying ${volDryPct.toFixed(0)}% · ready for bounce`,
      ruleChecklist: [
        ruleItem('NOT in momentum', !inMomentum, `bullishMA=${bullishMA}, slope=${ma20Slope.toFixed(2)}%`),
        ruleItem('Valid swing high/low identified', validFib, `swing high $${fibSwingHigh.toFixed(2)} / low $${fibSwingLow.toFixed(2)}`),
        ruleItem('Price in .500-.618 fib retracement zone', fibPosition >= 0.382 && fibPosition <= 0.62, `fibPos ${fibPosition.toFixed(2)} (need 0.38-0.62)`),
        ruleItem('Volume drying up (> 5% decline last 10d vs prior 10d)', volDryPct > 5, `${volDryPct.toFixed(1)}% drier`),
      ],
      entryStrategy: {
        type: 'fib',
        levelBest: fib618, levelBestLabel: '.618 (best)',
        levelSafe: fib50, levelSafeLabel: '.500 (safe)',
        stopBelow: fib618 * 0.97,
        target1: currentPrice + fibRange * 0.5,
        target2: currentPrice + fibRange,
      },
      facts, confidence: 75,
    };
  }
  
  // SETUP FORMING: tight base, low volume
  if (consolRangePct < 15 && volDryPct > 10) {
    return {
      mode: 'SETUP_FORMING',
      label: 'Setup Forming',
      color: 'purple',
      action: 'Wait — get ready. Tight base building.',
      reasoning: `Tight ${consolRangePct.toFixed(0)}% box · vol drying ${volDryPct.toFixed(0)}%`,
      ruleChecklist: [
        ruleItem('NOT in momentum (no uptrend yet)', !inMomentum, `bullishMA=${bullishMA}`),
        ruleItem('Tight 20-day box (< 15% range)', consolRangePct < 15, `${consolRangePct.toFixed(1)}% range (need <15)`),
        ruleItem('Volume drying up (> 10% decline)', volDryPct > 10, `${volDryPct.toFixed(1)}% drier`),
      ],
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
  
  // SLIGHT UPTREND, NO CLEAR SETUP: stock is above 20MA but MAs not aligned
  if (aboveMA20 && !lostMa50) {
    return {
      mode: 'WAIT',
      label: 'Choppy — no edge',
      color: 'gray',
      action: 'Above 20MA but no clear momentum or setup. Watch.',
      reasoning: `Above 20MA but MAs not aligned (9EMA ${distEma9>0?'+':''}${distEma9.toFixed(1)}%, 50MA ${distMa50>0?'+':''}${distMa50.toFixed(1)}%)`,
      ruleChecklist: [
        ruleItem('Price above 20 MA', aboveMA20, `$${currentPrice.toFixed(2)} vs $${ma20.toFixed(2)}`),
        ruleItem('Above 50 MA', aboveMA50, `${distMa50.toFixed(1)}% from 50MA`),
        ruleItem('MAs NOT aligned bullishly (would be momentum)', !bullishMA, `9EMA $${ema9.toFixed(2)} | 21EMA $${ema21.toFixed(2)} | 20MA $${ma20.toFixed(2)}`),
        ruleItem('NOT in fib zone (would be Setup Ready)', !(validFib && fibPosition >= 0.382 && fibPosition <= 0.62), `fibPos ${fibPosition.toFixed(2)}`),
        ruleItem('NOT a tight base (would be Setup Forming)', !(consolRangePct < 15 && volDryPct > 10), `${consolRangePct.toFixed(0)}% range, vol drying ${volDryPct.toFixed(0)}%`),
      ],
      entryStrategy: null,
      facts, confidence: 40,
    };
  }
  
  // DOWNTREND / WAIT
  return {
    mode: 'WAIT',
    label: 'Downtrend or no setup',
    color: 'gray',
    action: 'Below 20MA or no setup. Avoid for now.',
    reasoning: `${aboveMA20?'Above':'Below'} 20MA · ${distMa20.toFixed(1)}% from 20MA`,
    ruleChecklist: [
      ruleItem('Price above 20 MA', aboveMA20, `$${currentPrice.toFixed(2)} vs $${ma20.toFixed(2)}`),
      ruleItem('No bullish setup detected', true, 'Not in momentum, not in fib zone, not basing'),
    ],
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
