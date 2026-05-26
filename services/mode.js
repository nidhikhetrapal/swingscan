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
  
  // EMAs only — 9 / 21 / 50 (consistent math, faster reaction than SMAs)
  const ema9 = calcEMA(closes.slice(-40), 9);
  const ema21 = calcEMA(closes.slice(-60), 21);   // Replaces 20 SMA — earlier trend-break signal
  const ema50 = calcEMA(closes.slice(-150), 50);  // Replaces 50 SMA — primary trend
  
  // Distance from EMAs (%)
  const distEma9 = ((currentPrice - ema9) / ema9) * 100;
  const distEma21 = ((currentPrice - ema21) / ema21) * 100;
  const distEma50 = ((currentPrice - ema50) / ema50) * 100;
  
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
  
  // (21EMA slope removed — using ema21Slope above instead)
  
  // EMA STRUCTURE — KEY checks for momentum and trend health
  const aboveEma9 = currentPrice > ema9;
  const aboveEma21 = currentPrice > ema21;
  const aboveEma50 = currentPrice > ema50;
  
  // Trend slope on 21 EMA (last 10 days)
  const ema21_10ago = calcEMA(closes.slice(-70, -10), 21);
  const ema21Slope = ((ema21 - ema21_10ago) / ema21_10ago) * 100;
  
  // Bullish alignment: price > 9 EMA > 21 EMA > 50 EMA
  // All EMAs stacked in ascending order = clear uptrend
  const bullishMA = aboveEma9 && ema9 > ema21 && ema21 > ema50;
  
  // TREND BREAK SIGNALS — 21 EMA is the primary warning, 50 EMA is the major break
  const lostEma21 = !aboveEma21 && ema21Slope < 0;
  const nearEma21Break = aboveEma21 && distEma21 < 1 && ema21Slope < 0.3;
  const lostEma50 = !aboveEma50 && ema21 < ema50;  // deeper break
  
  // Recent breakout check
  const breakout = findRecentBreakout(candles, 60);
  
  // Facts object — EMAs only
  const facts = {
    rsi: +rsi.toFixed(1),
    ema9: +ema9.toFixed(2), ema21: +ema21.toFixed(2), ema50: +ema50.toFixed(2),
    distEma9: +distEma9.toFixed(2), distEma21: +distEma21.toFixed(2), distEma50: +distEma50.toFixed(2),
    ema21Slope: +ema21Slope.toFixed(2),
    consolHigh: +consolHigh.toFixed(2), consolLow: +consolLow.toFixed(2), consolRangePct: +consolRangePct.toFixed(1),
    daysSinceBreakout: breakout?.daysAgo,
    holdingBreakout: breakout && currentPrice > breakout.breakoutLevel,
    volRatio5_20: +volRatio5_20.toFixed(2),
    volDryPct: +volDryPct.toFixed(1),
    fibPosition: +fibPosition.toFixed(2),
    fib50: +fib50.toFixed(2), fib618: +fib618.toFixed(2),
    bullishMA, lostEma21, lostEma50,
  };

  // ═══════════════════════════════════════════════════════════════════
  // CLASSIFICATION — PRIORITY ORDER
  // 1. Check if BROKEN first (trend reversal)
  // 2. Then check MOMENTUM (uptrend present)
  //    - sub-classify by extension + RSI
  // 3. Then check SETUP modes (no uptrend, basing/pullback)
  // ═══════════════════════════════════════════════════════════════════
  
  // ── 1. TREND BREAK (using 21 EMA as primary trigger — earlier than 50EMA) ──
  // Major break: lost 50EMA + downtrend — already deep in trouble
  if (lostEma50 && distEma50 < -3) {
    return {
      mode: 'TREND_BREAK',
      label: 'Trend Break — Major',
      color: 'red',
      action: 'Exit / avoid. Trend is broken. Wait for new base.',
      reasoning: `Lost 50 EMA by ${Math.abs(distEma50).toFixed(1)}% · 21 EMA also broken${volRatio5_20 > 1.2 ? ' · vol confirming' : ''}`,
      ruleChecklist: [
        ruleItem('Price below 50 EMA', !aboveEma50, `$${currentPrice.toFixed(2)} vs 50EMA $${ema50.toFixed(2)}`),
        ruleItem('20 MA below 50 EMA (bearish cross)', ema21 < ema50, `21EMA $${ema21.toFixed(2)} vs 50EMA $${ema50.toFixed(2)}`),
        ruleItem('More than 3% below 50 EMA', distEma50 < -3, `${distEma50.toFixed(1)}% from 50EMA`),
      ],
      watchouts: volRatio5_20 > 1.2 ? [`Vol ${volRatio5_20.toFixed(1)}× confirming selling pressure`] : [`Vol ${volRatio5_20.toFixed(1)}× — low volume but break still bearish`],
      entryStrategy: null,
      facts, confidence: 85,
    };
  }
  
  // Early break: lost 21 EMA on volume, slope rolling over
  if (lostEma21 && distEma21 < -2) {
    return {
      mode: 'TREND_BREAK',
      label: 'Trend Break — Early Warning',
      color: 'red',
      action: 'Lost 21 EMA. Cut size or exit. 50EMA next support.',
      reasoning: `Lost 21 EMA by ${Math.abs(distEma21).toFixed(1)}% · slope ${ema21Slope.toFixed(1)}%/10d${volRatio5_20 > 1.2 ? ' · vol confirming' : ''}`,
      ruleChecklist: [
        ruleItem('Price below 21 EMA', !aboveEma21, `$${currentPrice.toFixed(2)} vs 21EMA $${ema21.toFixed(2)}`),
        ruleItem('21 EMA slope rolling over (negative)', ema21Slope < 0, `${ema21Slope.toFixed(2)}%/10d`),
        ruleItem('More than 2% below 21 EMA', distEma21 < -2, `${distEma21.toFixed(1)}% below`),
      ],
      watchouts: [volRatio5_20 > 1.2 ? `Vol ${volRatio5_20.toFixed(1)}× confirming break` : `Vol ${volRatio5_20.toFixed(1)}× — break still valid, watch for follow-through`],
      entryStrategy: {
        type: 'exit',
        stopBelow: ema50,
        stopLabel: '50 MA (deeper support)',
      },
      facts, confidence: 80,
    };
  }
  
  // ── 2. MOMENTUM CHECK ──
  // A stock is in MOMENTUM if MAs are aligned bullishly AND price above 21EMA AND trend rising
  const inMomentum = bullishMA && aboveEma21 && ema21Slope > 0;
  
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
    
    // LATE/EXHAUSTED MOMENTUM: very far from 21EMA OR climactic volume on extended move
    if (distEma21 > 25) {
      return {
        mode: 'LATE_MOMENTUM',
        label: 'Late/Exhausted Momentum',
        color: 'orange',
        action: "Don't chase. Wait for pullback to 9EMA or 21EMA.",
        reasoning: `Extended ${distEma21.toFixed(0)}% above 21EMA${volRatio5_20 > 2.0 ? ' · climactic vol' : ''}`,
        ruleChecklist: [
          ruleItem('In momentum (bullish MAs + above 21EMA + rising trend)', inMomentum, `bullishMA=${bullishMA}, above21EMA=${aboveEma21}, slope=${ema21Slope.toFixed(2)}%`),
          ruleItem('25%+ above 21 EMA (very extended)', distEma21 > 25, `${distEma21.toFixed(1)}% above 21EMA (need >25)`),
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
    
    // EXTENDED MOMENTUM: 10-25% above 21EMA — structure intact, just don't chase
    if (distEma21 > 10) {
      return {
        mode: 'EARLY_MOMENTUM',
        label: 'Extended Momentum',
        color: 'orange',
        action: `Don't chase here. Wait for pullback to 9EMA $${ema9.toFixed(2)} or 21EMA $${ema21.toFixed(2)}.`,
        reasoning: `${distEma21.toFixed(1)}% above 21EMA · MAs aligned · trend +${ema21Slope.toFixed(1)}%/10d`,
        ruleChecklist: [
          ruleItem('In momentum (bullish MAs + above 21EMA + rising trend)', inMomentum, `bullishMA=${bullishMA}, above21EMA=${aboveEma21}, slope=${ema21Slope.toFixed(2)}%`),
          ruleItem('10-25% above 21 EMA (extended but not yet exhausted)', distEma21 > 10 && distEma21 <= 25, `${distEma21.toFixed(1)}% above 21EMA`),
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
        reasoning: `Fresh breakout · ${distEma21.toFixed(1)}% above 21EMA · MAs aligned`,
        ruleChecklist: [
          ruleItem('In momentum (bullish MAs + above 21EMA + rising trend)', inMomentum, `bullishMA=${bullishMA}, above21EMA=${aboveEma21}, slope=${ema21Slope.toFixed(2)}%`),
          ruleItem('Broke out within last 15 days', breakout && breakout.daysAgo <= 15, breakout ? `${breakout.daysAgo} days ago at $${breakout.breakoutLevel.toFixed(2)}` : 'no recent breakout'),
          ruleItem('Holding above breakout level', breakout && currentPrice > breakout.breakoutLevel, breakout ? `$${currentPrice.toFixed(2)} vs $${breakout.breakoutLevel.toFixed(2)}` : '—'),
          ruleItem('NOT extended (< 10% above 21 EMA)', distEma21 <= 10, `${distEma21.toFixed(1)}% above 21EMA`),
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
    
    // ESTABLISHED MOMENTUM: in uptrend, less than 10% above 21EMA — healthy spot
    return {
      mode: 'ESTABLISHED_MOMENTUM',
      label: 'Established Momentum',
      color: 'green',
      action: distEma9 < 2 
        ? `Buy here near 9EMA $${ema9.toFixed(2)}. Add on pullback to 21EMA $${ema21.toFixed(2)}.`
        : `Hold / trail. Add on pullback to 9EMA $${ema9.toFixed(2)} or 21EMA $${ema21.toFixed(2)}.`,
      reasoning: `Healthy uptrend · ${distEma21.toFixed(1)}% above 21EMA · trend +${ema21Slope.toFixed(1)}%/10d`,
      ruleChecklist: [
        ruleItem('In momentum: bullish MA alignment (price > 9EMA > 21EMA > 50EMA)', bullishMA, `Price $${currentPrice.toFixed(2)} | 9EMA $${ema9.toFixed(2)} | 21EMA $${ema21.toFixed(2)} | 50EMA $${ema50.toFixed(2)}`),
        ruleItem('Price above 21 EMA', aboveEma21, `$${currentPrice.toFixed(2)} vs 21EMA $${ema21.toFixed(2)}`),
        ruleItem('20 MA rising (slope > 0)', ema21Slope > 0, `${ema21Slope.toFixed(2)}%/10d`),
        ruleItem('NOT extended (< 10% above 21 EMA)', distEma21 <= 10, `${distEma21.toFixed(1)}% above 21EMA (need ≤10)`),
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
  if (validFib && fibPosition >= 0.382 && fibPosition <= 0.62) {
    return {
      mode: 'SETUP_READY',
      label: 'Setup Ready',
      color: 'blue',
      action: `Enter on bounce. Fib zone $${fib618.toFixed(2)}-$${fib50.toFixed(2)}.`,
      reasoning: `In .500-.618 fib zone${volDryPct > 5 ? ' · vol drying ' + volDryPct.toFixed(0) + '%' : ''} · ready for bounce`,
      ruleChecklist: [
        ruleItem('NOT in momentum', !inMomentum, `bullishMA=${bullishMA}, slope=${ema21Slope.toFixed(2)}%`),
        ruleItem('Valid swing high/low identified', validFib, `swing high $${fibSwingHigh.toFixed(2)} / low $${fibSwingLow.toFixed(2)}`),
        ruleItem('Price in .500-.618 fib retracement zone', fibPosition >= 0.382 && fibPosition <= 0.62, `fibPos ${fibPosition.toFixed(2)} (need 0.38-0.62)`),
      ],
      watchouts: volDryPct > 5 ? [`Vol drying ${volDryPct.toFixed(0)}% — bullish confirmation`] : [`Vol ${volDryPct >= 0 ? 'flat' : 'rising'} (${volDryPct.toFixed(0)}%) — setup still valid without vol confirm`],
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
  if (consolRangePct < 15) {
    return {
      mode: 'SETUP_FORMING',
      label: 'Setup Forming',
      color: 'purple',
      action: 'Wait — get ready. Tight base building.',
      reasoning: `Tight ${consolRangePct.toFixed(0)}% box${volDryPct > 10 ? ' · vol drying ' + volDryPct.toFixed(0) + '%' : ''}`,
      ruleChecklist: [
        ruleItem('NOT in momentum (no uptrend yet)', !inMomentum, `bullishMA=${bullishMA}`),
        ruleItem('Tight 20-day box (< 15% range)', consolRangePct < 15, `${consolRangePct.toFixed(1)}% range (need <15)`),
      ],
      watchouts: volDryPct > 10 ? [`Vol drying ${volDryPct.toFixed(0)}% — confirming base`] : [`Vol ${volDryPct > 0 ? 'drying ' + volDryPct.toFixed(0) + '%' : 'flat/rising'} — base still valid`],
      entryStrategy: {
        type: 'breakout_or_pullback',
        breakoutLevel: consolHigh * 1.02,
        breakoutLabel: 'Breakout: 2% above box',
        pullbackLevel: validFib ? fib50 : ema21,
        pullbackLabel: validFib ? '.500 fib' : '21EMA',
      },
      facts, confidence: 60,
    };
  }
  
  // SLIGHT UPTREND, NO CLEAR SETUP: stock is above 21EMA but MAs not aligned
  if (aboveEma21 && !lostEma50) {
    return {
      mode: 'WAIT',
      label: 'Choppy — no edge',
      color: 'gray',
      action: 'Above 21EMA but no clear momentum or setup. Watch.',
      reasoning: `Above 21EMA but MAs not aligned (9EMA ${distEma9>0?'+':''}${distEma9.toFixed(1)}%, 50EMA ${distEma50>0?'+':''}${distEma50.toFixed(1)}%)`,
      ruleChecklist: [
        ruleItem('Price above 21 EMA', aboveEma21, `$${currentPrice.toFixed(2)} vs $${ema21.toFixed(2)}`),
        ruleItem('Above 50 MA', aboveEma50, `${distEma50.toFixed(1)}% from 50EMA`),
        ruleItem('MAs NOT aligned bullishly (would be momentum)', !bullishMA, `9EMA $${ema9.toFixed(2)} | 21EMA $${ema21.toFixed(2)} | 21EMA $${ema21.toFixed(2)}`),
        ruleItem('NOT in fib zone (would be Setup Ready)', !(validFib && fibPosition >= 0.382 && fibPosition <= 0.62), `fibPos ${fibPosition.toFixed(2)}`),
        ruleItem('NOT a tight base (would be Setup Forming)', !(consolRangePct < 15), `${consolRangePct.toFixed(0)}% range (need <15)`),
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
    action: 'Below 21EMA or no setup. Avoid for now.',
    reasoning: `${aboveEma21?'Above':'Below'} 21EMA · ${distEma21.toFixed(1)}% from 21EMA`,
    ruleChecklist: [
      ruleItem('Price above 21 EMA', aboveEma21, `$${currentPrice.toFixed(2)} vs $${ema21.toFixed(2)}`),
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
