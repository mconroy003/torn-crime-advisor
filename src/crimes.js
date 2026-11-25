// ---------- crimes: one analyzer per crime ----------
// Each returns { actionable, note, options: [{ label, detail, best }] }.
// Cross-crime ranking uses measured $/N (crimeRate); analyzers pick the best option inside a crime.


// Emforus: dead-body jobs are the top Disposal earners. Used only to order jobs until your own log has values.
const DISPOSAL_PRIORITY = ['Dead Body', 'Body Part', 'Murder Weapon', 'Firearm', 'Vehicle'];

// How long each crime's live state stays trustworthy without a fresh look (minutes).
// Daily crimes (Disposal, Cracking, Arson) get new jobs at 00:00 TCT instead.
const STALE_AFTER_MIN = { 1: 60, 2: 360, 3: 1440, 4: 15, 5: 1, 6: 360, 7: 1440, 8: 60, 11: 180, 12: 60 };
const DAILY = { 9: 'jobs', 10: 'targets', 13: 'jobs' };

function lastTctMidnight(now) { return Math.floor(now / 86400000) * 86400000; }

function freshness(typeID, seenAt, now) {
  if (!seenAt) return { known: false };
  const ageMin = (now - seenAt) / 60000;
  if (DAILY[typeID]) {
    const newDay = seenAt < lastTctMidnight(now);
    return { known: true, newDay, stale: newDay, ageMin };
  }
  const limit = STALE_AFTER_MIN[typeID];
  return { known: true, newDay: false, stale: limit !== undefined && ageMin > limit, ageMin };
}

// Search for Cash by the clock (all TCT). Higher is better, 0-100. Used when the last look is over an hour old.
function sfcByClock(title, now) {
  const d = new Date(now);
  const dow = (d.getUTCDay() + 6) % 7;            // Mon=0 … Sun=6
  const hour = d.getUTCHours() + d.getUTCMinutes() / 60;
  const weekHours = dow * 24 + hour;              // hours since Monday 00:00
  const weekday = dow < 5;
  const t = String(title).toLowerCase();
  if (t.includes('trash')) {                       // collected Mon 06–18; fills up through the week
    const since = (weekHours - 18 + 168) % 168;
    return { pct: Math.round(Math.min(100, since / 150 * 100)), why: 'fills until Monday collection (06–18)' };
  }
  if (t.includes('junkyard')) {                    // crushing weekdays 09–16: best Monday morning, worst Friday evening
    const crushed = Math.min(5, dow) * 7 + (weekday ? Math.max(0, Math.min(7, hour - 9)) : 0);
    return { pct: Math.round(100 - crushed / 35 * 90), why: 'drops with each weekday crushing (09–16)' };
  }
  if (t.includes('cemetery')) {                    // groundskeepers weekdays 09–17
    const on = weekday && hour >= 9 && hour < 17;
    return { pct: on ? 25 : 75, why: on ? 'groundskeepers on now (weekdays 09–17)' : 'no groundskeepers right now' };
  }
  if (t.includes('fountain')) {                    // collected the 1st, 13–16
    const dim = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    return { pct: Math.round((d.getUTCDate() - 1 + hour / 24) / dim * 100), why: 'fills until collection on the 1st' };
  }
  return null;                                     // Subway (players online) and Beach (tide) need a look
}


// Scamming targets: the field names for hesitation/concern aren't confirmed yet, so look for them broadly.
// A target counts as waiting when it is hesitating or otherwise on a timer you can't act through.
function scamFlags(t) {
  const text = JSON.stringify(t).toLowerCase();
  return { hesitation: /hesitat|cooldown|cooling/.test(text), concern: /concern/.test(text) };
}
function scamWaitSeconds(t) {
  const now = Date.now() / 1000;
  let best = 0;
  (function walk(o, depth) {
    if (!o || typeof o !== 'object' || depth > 3) return;
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'number' && /hesitat|cooldown|until/i.test(k) && v > now && v < now + 86400) best = best ? Math.min(best, v - now) : v - now;
      else if (typeof v === 'object') walk(v, depth + 1);
    }
  })(t, 0);
  return best;
}
function scamTargetWaiting(t) {
  const f = scamFlags(t);
  if (f.hesitation) return true;
  return scamWaitSeconds(t) > 0 && !f.concern;
}
function scamTargetConcern(t) { return scamFlags(t).concern; }

const Analyzers = {
  9(db, data, ctx) { // Disposal
    const jobs = (db.crimesByType && db.crimesByType.objects) || [];
    const opts = jobs.map(job => {
      const methods = (job.methods || []).filter(m => m.available !== false && !m.locked).map(m => {
        const sr = successRate(db.stats, m.crimeID);
        const learned = actionValue(data, 9, m.crimeID);
        return { m, sr, learned, score: learned ? learned.perNerve : sr.p / m.nerve };
      });
      if (!methods.length) return null;
      // Learned $/N wins; otherwise pick the method with the best success per nerve (payout assumed set by job type).
      methods.sort((a, b) => (b.learned ? 1 : 0) - (a.learned ? 1 : 0) || b.score - a.score);
      const best = methods[0];
      const pr = DISPOSAL_PRIORITY.indexOf(job.title);
      const b = blend(ctx.rate, best.learned);
      return {
        key: job.title, method: best.m.title, perN: b.perN, nerve: best.m.nerve, units: 1, src: b.src,
        short: `${best.m.title} · ${best.m.nerve}N · ${Math.round(best.sr.p * 100)}%` + (best.learned ? ` · ${fmt.perN(best.learned.perNerve)}` : ''),
        label: job.title + (job.expiresSoon ? ' (expires soon)' : ''),
        detail: `${best.m.title} · ${best.m.nerve}N · ${Math.round(best.sr.p * 100)}% success (${best.sr.suc}/${best.sr.att})` +
          (best.learned ? ` · ${fmt.perN(best.learned.perNerve)} from ${best.learned.n} tries` : ''),
        sort: (best.learned ? best.learned.perNerve : 0) * 1000 + (pr === -1 ? 0 : (DISPOSAL_PRIORITY.length - pr) * 100) + best.score,
      };
    }).filter(Boolean).sort((a, b) => b.sort - a.sort);
    if (opts.length) opts[0].best = true;
    return {
      actionable: opts.length > 0,
      note: opts.length ? `Next: ${opts[0].label} → ${opts[0].method} · ${opts.length} jobs open` : 'No jobs left today; new ones spawn at 00:00 TCT',
      options: opts,
    };
  },

  10(db, data) { // Cracking
    const cbt = db.crimesByType || {};
    const brute = successRate(db.stats, 205).p;
    // Each brute-force attempt clears about "bruteforcePower" characters/layers (your stats: ~3 attempts per password).
    const power = Math.max(1, parseFloat(cbt.rig && cbt.rig.bruteforcePower) || data.rigPower || 1);
    const opts = (cbt.targets || []).filter(t => !t.isCracked && !(t.expire && t.expire * 1000 < Date.now())).map(t => {
      const chars = t.password || [];
      const units = chars.reduce((s, c) => s + ((c.char && c.char !== '*') ? 0 : (c.status || 0)), 0);
      const revealed = chars.some(c => c.char && c.char !== '*');
      const nerve = Math.round(Math.ceil(units / power) * 7 / brute + 5);
      const range = REF.cracking[String(t.title).toLowerCase()];
      const perN = range ? mid(range) / nerve : null;
      return {
        key: t.title, service: t.service, perN, nerve, units: 1, src: 'wiki est',
        short: `${perN ? 'est ' + fmt.perN(perN) : 'payout unknown'} · ~${nerve}N`,
        label: `${t.title} — ${t.service}${revealed ? ' (in progress)' : ''}`,
        detail: `${chars.length} chars · ~${nerve}N left · ${range ? `${fmt.money(range[0])}–${fmt.money(range[1])}` : 'payout unknown'}` +
          ` · est ${fmt.perN(perN)} · expires in ${fmt.dur(t.expire - Date.now() / 1000)}`,
        sort: (revealed ? 1e9 : 0) + (perN || 0),
      };
    }).sort((a, b) => b.sort - a.sort);
    if (opts.length) opts[0].best = true;
    const heat = cbt.rig && cbt.rig.hottestComponent;
    return {
      actionable: opts.length > 0 && !(heat >= 95),
      note: heat >= 95 ? `Rig is hot (${heat}%); let it cool ~${Math.ceil(heat - 90)} min` :
        opts.length ? `Next: ${opts[0].label}${/in progress/.test(opts[0].label) ? ' (finish it first)' : ''} · ${opts.length} targets` : 'No targets left; new ones at 00:00 TCT',
      options: opts,
    };
  },

  4(db, data, ctx) { // Shoplifting
    const now = Date.now();
    const stores = Array.isArray(db.crimesByType) ? db.crimesByType : [];
    const opts = stores.map(s => {
      const info = s.additionalInfo || {};
      const fx = info.statusEffects || [];
      const down = fx.filter(e => e.disabled);
      fx.forEach(e => {
        const k = `${s.title}|${e.title}`;
        if (e.disabled) { if (!data.outages[k]) data.outages[k] = now; } else delete data.outages[k];
      });
      const learned = actionValue(data, 4, s.crimeID);
      const downTxt = down.map(e => `${e.title} down (seen ${fmt.ago(data.outages[`${s.title}|${e.title}`])})`).join(', ');
      const b = blend(ctx.rate, learned);
      const allDown = fx.length > 0 && down.length === fx.length;
      return {
        key: s.title, perN: (allDown || learned) ? b.perN : null, nerve: s.nerve || 4, units: Infinity, src: b.src,
        short: (down.length === fx.length && fx.length ? 'all security down' : `${down.length}/${fx.length} down`) + (learned ? ` · ${fmt.perN(learned.perNerve)}` : ''),
        label: s.title,
        detail: `${down.length}/${fx.length} security down${downTxt ? ': ' + downTxt : ''} · notoriety ${info.notoriety || 0}%` +
          (learned ? ` · ${fmt.perN(learned.perNerve)} from ${learned.n} tries` : ''),
        sort: (learned ? learned.perNerve : 0) + (fx.length ? down.length / fx.length : 0) * 1e6 + (down.length === fx.length && fx.length ? 1e7 : 0),
        allDown: fx.length > 0 && down.length === fx.length,
      };
    }).sort((a, b) => b.sort - a.sort);
    if (opts.length) opts[0].best = true;
    const open = opts.filter(o => o.allDown).map(o => o.label);
    return {
      actionable: true,
      note: open.length ? `Next: ${open[0]} (all security down)` : 'Skip for now: no store has all its security down',
      options: opts,
    };
  },

  1(db, data, ctx) { // Search for Cash
    const old = ctx.fresh.ageMin > 60;
    const locs = (Array.isArray(db.crimesByType) ? db.crimesByType : []).map(c => {
      const a = c.additionalInfo || {};
      const est = old ? sfcByClock(c.title, ctx.now) : null;
      const pct = est ? est.pct : (a.barValue ?? null);
      const tag = est ? `~${pct}% (clock)` : old ? `${pct ?? '?'}% (${fmt.ago(ctx.fresh.ageMin ? Date.now() - ctx.fresh.ageMin * 60000 : null)})` : `${pct ?? '?'}%`;
      // An old reading the clock can't update (Subway, Beach) counts for less.
      const sortPct = (pct || 0) * (old && !est ? 0.8 : 1);
      return { key: c.title, short: tag, label: c.title.replace('Search the ', ''),
        detail: est ? `${tag} · ${est.why}` : `${tag} · ${a.title || ''}`, sort: sortPct, pct };
    }).sort((a, b) => b.sort - a.sort);
    if (locs.length) locs[0].best = true;
    return { actionable: true, note: locs.length ? `Best now: ${locs[0].label} (${locs[0].short})` : '', options: locs };
  },

  2(db) { // Bootlegging: copy DVDs → sell (street, 5N) or let the online store sell them → collect (1N)
    const gi = db.generalInfo || {};
    const st = db.stats || {};
    const subs = Array.isArray(db.crimesByType) ? db.crimesByType : [];
    const store = subs.find(c => c.title === 'Online Store');
    const copy = subs.find(c => c.title === 'Copy DVDs');
    const stock = Object.values(gi.CDs || {}).reduce((s, n) => s + n, 0);
    const empty = Object.values(gi.CDs || {}).filter(n => !n).length;
    const toCollect = store && store.additionalInfo ? store.additionalInfo.moneyToCollect : 0;
    const blanks = copy && copy.additionalInfo ? copy.additionalInfo.blankCDs : null;
    const perDvd = st.CDsSoldTotal ? (st.moneyMadeTotal || st.moneyFoundTotal) / st.CDsSoldTotal : null;
    const steps = [];
    if (toCollect > 0) steps.push({ action: `Collect ${fmt.money(toCollect)} from the online store (1N)`, perN: toCollect, nerve: 1, units: 1 });
    const storeOn = store && store.additionalInfo && store.additionalInfo.enabled;
    if (storeOn && (stock === 0 || empty) && blanks) steps.push({ action: `Copy DVDs to restock${empty ? ` ${empty} empty genre${empty > 1 ? 's' : ''}` : ''} (${blanks} blanks on hand)`, perN: null, deferred: true, why: `the store sells them for you, ~${fmt.money(perDvd)} each` });
    const next = steps[0];
    return {
      actionable: !!next,
      note: next ? `Next: ${next.action}${next.why ? ' — ' + next.why : ''}` : `${stock} DVDs in stock; the store is selling`,
      steps, stepRate: next ? next.perN : null, options: [],
    };
  },
  3(db) { // Graffiti
    const d = (Array.isArray(db.crimesByType) ? db.crimesByType : []).map(c => (c.additionalInfo || {}).reputation || 0);
    return { actionable: true, note: d.length ? `Low earner: tag only to keep reputation up (lowest district ${Math.min(...d)} stars)` : '', options: [] };
  },

  5(db, data) { // Pickpocketing: marks are live for seconds, so this only labels the page
    const marks = Array.isArray(db.crimesByType) ? db.crimesByType : [];
    const opts = marks.map(m => {
      const range = REF.pickpocketing[String(m.title).toLowerCase()];
      const sr = successRate(db.stats, m.crimeID);
      const b = blend(range ? mid(range) * sr.p / (m.nerve || 5) : null, actionValue(data, 5, m.crimeID));
      const status = m.crimeInfo && m.crimeInfo.status ? m.crimeInfo.status.title : '';
      const learnedPP = actionValue(data, 5, m.crimeID);
      return { key: m.title, perN: b.perN, nerve: m.nerve || 5, units: 0, src: b.src, noPick: !learnedPP,
        short: b.perN !== null ? `${fmt.perN(b.perN)} · ${Math.round(sr.p * 100)}%` : `${Math.round(sr.p * 100)}%`,
        label: m.title, detail: `${status} · ${range ? `${fmt.money(range[0])}–${fmt.money(range[1])}` : 'cash unknown'} · ${b.src}`,
        sort: b.perN || 0 };
    }).sort((a, b) => b.sort - a.sort);
    if (opts.length && opts[0].perN) opts[0].best = true;
    return { actionable: true, note: 'Marks are live for seconds; the page labels show which are worth 5N', options: opts };
  },

  6(db) { // Card Skimming: install → let cards build → recover (4N) → sell in a batch (6N)
    const st = db.stats || {};
    const c = db.crimesByType || {};
    const subs = c.subCrimes || [];
    const perCard = st.cardDetailsSold ? (st.moneyMadeTotal || st.moneyFoundTotal) / st.cardDetailsSold : 215;
    // Your typical haul per skimmer when recovered, and how often skimmers are lost.
    const avgHaul = st.skimmersRecovered ? st.cardDetailsRecovered / st.skimmersRecovered : 40;
    const lossRate = st.skimmersInstalled ? (st.skimmersLost || 0) / st.skimmersInstalled : 0.3;
    const ripe = subs.filter(s => s.crimeInfo && s.crimeInfo.cards >= avgHaul);
    const cardsHeld = (c.sellCards && c.sellCards.additionalInfo && c.sellCards.additionalInfo.collectedCards) || 0;
    const steps = [];
    if (cardsHeld > 0) steps.push({ action: `Sell ${cardsHeld} card details (6N)`, perN: cardsHeld * perCard / 6, nerve: 6, units: 1, why: `~${fmt.money(perCard)} each` });
    if (ripe.length) steps.push({ action: `Recover ${ripe.length} skimmer${ripe.length > 1 ? 's' : ''} with ${Math.round(avgHaul)}+ cards (4N each)`, perN: avgHaul * perCard / 4, nerve: 4, units: ripe.length, why: 'they hold your usual haul; waiting longer risks losing them' });
    const active = st.skimmersActive || subs.length;
    const installRate = avgHaul * perCard * (1 - lossRate) / (6 + 4 + 6 / Math.max(1, avgHaul / 10));
    if (active < 20) steps.push({ action: `Install ${20 - active} more skimmer${20 - active > 1 ? 's' : ''} (6N each)`, perN: installRate, deferred: true, nerve: 6, units: 20 - active, why: `pays out over days; ${Math.round(lossRate * 100)}% of your skimmers get lost` });
    const most = subs.reduce((m, s) => Math.max(m, (s.crimeInfo && s.crimeInfo.cards) || 0), 0);
    const next = steps[0];
    return {
      actionable: !!next,
      note: next ? `Next: ${next.action} — ${next.why}` : `Let them build: ${active} skimmers, fullest has ${Math.round(most)} cards (you usually recover at ~${Math.round(avgHaul)})`,
      steps, stepRate: next ? next.perN : null, options: [],
    };
  },
  7(db, data) { // Burglary
    const props = ((db.crimesByType && db.crimesByType.properties) || []).filter(p => !(p.expire && p.expire * 1000 < Date.now()));
    const soon = props.filter(p => p.expiresSoon).length;
    const opts = props.map(p => {
      const range = REF.burglary[String(p.title).toLowerCase()];
      const sr = successRate(db.stats, p.burgleCrimeID);
      const nerve = (p.burgleNerve || 6) + (p.confidence >= 40 ? 0 : 2 * (p.caseNerve || 2));
      const b = blend(range ? mid(range) * sr.p / nerve : null, actionValue(data, 7, p.burgleCrimeID));
      // Burglary pays cash only some of the time, so the wiki range alone can't drive the top pick.
      const learnedB = actionValue(data, 7, p.burgleCrimeID);
      return {
      key: p.title, perN: b.perN, nerve, units: 1, src: b.src + (range ? ' + items' : ''), noPick: !learnedB,
      short: `${p.confidence}% confidence` + (p.recommendedItem && !p.recommendedItem.owned ? ` · missing ${p.recommendedItem.title}` : '') + (p.expiresSoon ? ' · expiring' : ''),
      label: p.title,
      detail: `confidence ${p.confidence}% · ${p.safetyStatus}` +
        (p.recommendedItem ? ` · needs ${p.recommendedItem.title}${p.recommendedItem.owned ? ' (owned)' : ' (MISSING)'}` : '') +
        ` · expires in ${fmt.dur(p.expire - Date.now() / 1000)}`,
      sort: (b.perN || 0) + (p.safetyStatus === 'safe' ? 1e6 : 0) + p.confidence,
    }; }).sort((a, b) => b.sort - a.sort);
    if (opts.length) opts[0].best = true;
    const ready = props.filter(p => p.safetyStatus === 'safe' || p.confidence >= 40);
    const next = ready.length ? `Burgle ${ready[0].title} (${ready[0].confidence}% confidence)`
      : props.length < 3 ? 'Scout for more targets (3N)'
      : `Case ${opts[0].key} to raise its confidence (2N)`;
    return { actionable: props.length > 0, note: `Next: ${next} · ${props.length} targets${soon ? `, ${soon} expiring soon` : ''}`, options: opts };
  },

  8(db) { // Hustling: collect from accomplices first; the games themselves lose money at your level
    const c = db.crimesByType || {};
    const st = db.stats || {};
    const sh = (c.shill && c.shill.additionalInfo && c.shill.additionalInfo.moneyToCollect) || 0;
    const pp = (c.pickpocket && c.pickpocket.additionalInfo && c.pickpocket.additionalInfo.moneyToCollect) || 0;
    const steps = [];
    if (sh) steps.push({ action: `Collect ${fmt.money(sh)} from your shill (2N)`, perN: sh / 2, nerve: 2, units: 1 });
    if (pp) steps.push({ action: `Collect ${fmt.money(pp)} from your pickpocket (2N)`, perN: pp / 2, nerve: 2, units: 1 });
    const net = (st.totalMoneyWon || 0) - (st.totalMoneyLost || 0);
    return {
      actionable: steps.length > 0,
      note: steps.length ? `Next: ${steps[0].action}` : `Nothing to collect · your games are ${fmt.money(net)} overall, so skip them for money`,
      steps, stepRate: steps.length ? steps[0].perN : null, options: [],
    };
  },
  11(db) { // Forgery
    const c = db.crimesByType || {};
    const st = db.stats || {};
    const att = Object.values(st.crimesByIDAttempts || {}).reduce((a, b) => a + b, 0);
    const suc = Object.values(st.crimesByIDAttemptsSucc || {}).reduce((a, b) => a + b, 0);
    const pStep = att ? (suc + 4) / (att + 5) : 0.9;
    const opts = (c.beginProject || []).filter(bp => bp.available !== false).map(bp => {
      const name = String(bp.title).replace(/^Begin /, '').replace(/ project$/, '');
      const price = REF.forgery[name.toLowerCase()];
      const steps = (bp.steps || []).length || 4;
      const nerve = steps * 5;
      const perN = price ? price * Math.pow(pStep, steps) / nerve : null;
      return { key: name, perN, nerve, units: Infinity, src: 'before materials', noPick: true,
        short: perN ? `est ${fmt.perN(perN)} · ${nerve}N` : 'price unknown',
        label: name, detail: `${steps} steps · ${nerve}N · ${price ? fmt.money(price) + ' at the Print Store, before materials' : 'price unknown'}`,
        sort: perN || 0 };
    }).sort((a, b) => b.sort - a.sort);
    if (opts.length && opts[0].perN) opts[0].best = true;
    const n = (c.projects || []).length;
    return { actionable: opts.some(o => o.perN), note: `${n} projects active${opts[0] && opts[0].perN ? ` · best: ${opts[0].label}` : ''}`, options: opts };
  },

  12(db) { // Scamming: farm → spam wave → reply to targets → capitalize
    const c = db.crimesByType || {};
    const st = db.stats || {};
    const targets = c.targets || [];
    const scammed = (st.targetsScammedSucc || 0) + (st.targetsScammedFail || 0);
    // Your own averages: cash per target worked, replies per target, targets per spam wave.
    const ids = st.crimesByIDAttempts || {};
    const replies = Object.entries(ids).filter(([k]) => +k >= 292 && +k <= 312 && +k % 2 === 0).reduce((a, [, v]) => a + v, 0);
    const waves = Object.entries(ids).filter(([k]) => +k >= 291 && +k <= 311 && +k % 2 === 1).reduce((a, [, v]) => a + v, 0);
    const perTarget = scammed ? (st.moneyAwarded || st.moneyFoundTotal || 0) / scammed : null;
    const nervePerTarget = scammed ? replies * 3 / scammed : 21;
    const targetsPerWave = waves ? scammed / waves : 2;
    const workRate = perTarget ? perTarget / nervePerTarget : null;
    const waveRate = perTarget ? targetsPerWave * perTarget / (8 + targetsPerWave * nervePerTarget) : null;
    // Spam type: the highest-paying one that isn't worn out (red arrow = "depreciation").
    const tiers = ['Investment', 'Romance', 'Advance-fee', 'Job', 'Tax', 'Vacation', 'Tech support', 'Charity', 'Family', 'Prize', 'Delivery'];
    const methods = (c.methods || []).filter(m => m.available !== false && !(m.requirements && m.requirements.minCrimeLevel && m.requirements.minCrimeLevel.available === false));
    const rank = m => { const i = tiers.findIndex(t => m.title.includes(t)); return i < 0 ? 99 : i; };
    const fresh = methods.filter(m => !m.depreciation).sort((a, b) => rank(a) - rank(b));
    const worn = methods.filter(m => m.depreciation).map(m => m.title.replace('Spam : ', '').replace(' scam', ''));
    const spam = fresh[0] || null;
    const farming = (c.farming && c.farming.currentOngoing) || [];
    const farmTxt = farming.length ? farming.map(f => `${f.type} ${f.currentValue.toLocaleString('en-US')}`).join(', ') : 'no scraper or phisher running';
    const waitingOn = targets.filter(scamTargetWaiting);
    const concerned = targets.filter(t => !waitingOn.includes(t) && scamTargetConcern(t));
    const replyable = targets.filter(t => !waitingOn.includes(t) && !concerned.includes(t));
    const steps = [];
    if (concerned.length) steps.push({ action: `Resolve the concern on ${concerned.length} target${concerned.length > 1 ? 's' : ''} (3N per try)`, perN: workRate ? workRate * 0.5 : null, nerve: 3, units: concerned.length * 2,
      why: 'concerns often take a few tries; you resolve about ' + (st.concernsAttempts ? Math.round(100 * (st.concernsResolved || 0) / st.concernsAttempts) : '?') + '% of attempts' });
    if (replyable.length) steps.push({ action: `Reply to ${replyable.length} target${replyable.length > 1 ? 's' : ''} (3N per reply)`, perN: workRate, nerve: 3, units: Math.round(replyable.length * nervePerTarget / 3), why: `you average ${fmt.money(perTarget)} per target for ~${Math.round(nervePerTarget)}N` });
    if (waitingOn.length && !replyable.length && !concerned.length) {
      const soonest = Math.min(...waitingOn.map(scamWaitSeconds).filter(x => x > 0));
      steps.push({ action: `Wait: ${waitingOn.length} target${waitingOn.length > 1 ? 's are' : ' is'} hesitating${Number.isFinite(soonest) ? ` (next free in ~${fmt.dur(soonest)})` : ' (usually 1–2 h)'}`, perN: null, wait: true });
    }
    if (c.awaitingResponses) steps.push({ action: 'Wait: responses are still coming in from your last wave', perN: null, wait: true });
    else if (spam) steps.push({ action: `Send ${/^[AEIOU]/.test(spam.title.replace('Spam : ', '')) ? 'an' : 'a'} ${spam.title.replace('Spam : ', '')} wave (8N) if you have emails, else farm (8N)`, perN: waveRate, deferred: true, nerve: 8, units: 1,
      why: `pays once replies arrive: ~${targetsPerWave.toFixed(1)} targets per wave, ~${Math.round(8 + targetsPerWave * nervePerTarget)}N in total${worn.length ? ` · worn out: ${worn.join(', ')}` : ''}` });
    if (!farming.length) steps.push({ action: 'Restart a scraper or phisher (Email Farming, 8N)', perN: null, why: 'emails feed every wave' });
    const next = steps[0];
    return {
      actionable: !!next && !next.wait,
      note: next ? `Next: ${next.action}${next.why ? ' — ' + next.why : ''}` : 'Nothing to do',
      steps, stepRate: next && !next.wait ? next.perN : null,
      options: [], detail: `Farming: ${farmTxt}`,
    };
  },
  13(db) { // Arson: collect → light every hands-off job and let it burn → then work the jobs that need watching
    const c = db.crimesByType || {};
    const st = db.stats || {};
    const jobs = c.targets || [];
    const have = Object.fromEntries((c.availableItems || []).map(i => [i.itemID, i.total]));
    const perJob = st.rewardsCollected ? st.moneyFoundTotal / st.rewardsCollected : null;
    const nervePerJob = st.rewardsCollected ? st.nerveUsed / st.rewardsCollected : 23;
    const rate = perJob ? perJob / nervePerJob : null;
    const acts = j => (j.availableActions || []).map(a => a.title);
    const first = j => (j.availableActions || [])[0] || {};
    const needs = j => (j.icons || []).filter(i => i.type === 'B2' && Array.isArray(i.value));
    const missing = j => needs(j).some(i => !i.value.some(id => (have[id] || 0) > 0));
    // Damage rule: C2 total destruction and C4 "more than X%" can burn out on their own;
    // C3 "less than X%" and C5 "between X and Y%" have a ceiling, so they need watching and dampening.
    const ceiling = j => (j.icons || []).some(i => i.type === 'C3' || i.type === 'C5');
    const isCollect = j => acts(j).some(t => /collect/i.test(t));
    const isBurning = j => !isCollect(j) && (j.damage !== null && j.damage !== undefined || acts(j).some(t => /stoke|dampen/i.test(t)));
    const notLit = j => !isCollect(j) && !isBurning(j);

    const collect = jobs.filter(isCollect);
    const progress = j => (/inquire/i.test(first(j).title || '') ? 0 : 1);   // jobs already started come first
    const handsOff = jobs.filter(j => notLit(j) && !ceiling(j) && !missing(j)).sort((a, b) => progress(b) - progress(a));
    const watched = jobs.filter(j => !isCollect(j) && ceiling(j) && !missing(j)).sort((a, b) => isBurning(b) - isBurning(a) || progress(b) - progress(a));
    const burningAlone = jobs.filter(j => isBurning(j) && !ceiling(j));
    const blocked = jobs.filter(j => notLit(j) && missing(j));
    const rule = j => ((j.icons || []).find(i => /^C/.test(i.type)) || {}).title || 'no damage limit';
    const nextAct = j => `${first(j).title}${first(j).nerve ? ` (${first(j).nerve}N)` : ' (free)'}`;

    const steps = [];
    if (collect.length) steps.push({ action: `Collect ${collect.length} finished job${collect.length > 1 ? 's' : ''} (2N each, can't fail)`,
      perN: perJob ? perJob / 2 : null, nerve: 2, units: collect.length, why: `about ${fmt.money(perJob)} each` });
    if (handsOff.length) steps.push({ action: `Light ${handsOff[0].title}: ${nextAct(handsOff[0])}, through Ignite, then leave it to burn` +
        (handsOff.length > 1 ? ` · ${handsOff.length - 1} more to light the same way` : ''),
      perN: rate, nerve: 13, units: handsOff.length,
      why: `${rule(handsOff[0])}, so it can burn out on its own; start these first so they burn while you do the rest` });
    if (watched.length) steps.push({ action: `Work ${watched[0].title} (${rule(watched[0])}): ${isBurning(watched[0]) ? 'watch it and dampen before it passes the limit' : nextAct(watched[0])}` +
        (watched.length > 1 ? ` · ${watched.length - 1} more like it` : ''),
      perN: rate, nerve: Math.round(nervePerJob), units: watched.length,
      why: 'has a damage ceiling, so stay with it until you collect' });

    const status = [
      burningAlone.length ? `${burningAlone.length} burning on their own` : null,
      blocked.length ? `missing items for ${blocked.slice(0, 2).map(j => `${j.title} (${needs(j)[0].title.replace(/^.*: /, '')})`).join(', ')}` : null,
    ].filter(Boolean).join(' · ');
    const next = steps[0];
    return {
      actionable: steps.length > 0,
      note: next ? `Next: ${next.action}${next.why ? ' — ' + next.why : ''}${status ? ' · ' + status : ''}`
        : (burningAlone.length ? `Let ${burningAlone.length} fire${burningAlone.length > 1 ? 's' : ''} burn; collect when they finish` : 'No jobs'),
      steps, stepRate: next ? next.perN : null, options: [],
    };
  },
};

// Build the ranked list across all crimes.
const pickableCount = opts => opts.filter(o => !o.noPick).length;

function rankAll(data) {
  const rows = Object.keys(CRIMES).map(Number).map(typeID => {
    const st = data.state[typeID];
    const rate = crimeRate(data, typeID);
    const now = Date.now();
    const fresh = freshness(typeID, st && st.seenAt, now);
    let a = { actionable: false, note: 'Open this crime once so the Advisor can read it', options: [] };
    if (st && fresh.newDay) {
      // A new TCT day: yesterday's list is gone and new ones have spawned.
      a = { actionable: true, note: `New ${DAILY[typeID]} since 00:00 TCT — open to see them`, options: [] };
    } else if (st && Analyzers[typeID]) {
      try { a = Analyzers[typeID](st.db, data, { now, fresh, rate: rate.rate }); } catch (e) { a = { actionable: false, note: 'Could not read this crime: ' + e.message, options: [] }; }
      if (fresh.stale) a.note = `${a.note} (as of ${fmt.ago(st.seenAt)})`;
    }
    if (DAILY[typeID] && st && !fresh.newDay && !a.actionable) {
      a.note = `${a.note} · next ${DAILY[typeID]} in ${fmt.dur((lastTctMidnight(now) + 86400000 - now) / 1000)}`;
    }
    // "now": the best option's estimate where the crime has per-option numbers (and isn't live-only), else your crime rate.
    const plannable = (a.options || []).filter(o => o.perN !== null && o.perN !== undefined && o.units !== 0);
    // An estimate that leaves out known costs (Forgery materials) is shown but can't be the top pick.
    const noPick = plannable.length > 0 && pickableCount(plannable) === 0;
    const pickable = plannable.filter(o => !o.noPick);
    const bestOpt = (pickable.length ? pickable : plannable).sort((x, y) => y.perN - x.perN)[0];
    let nowRate = a.actionable && bestOpt && !fresh.newDay ? bestOpt.perN : rate.rate;
    let nowSrc = a.actionable && bestOpt && !fresh.newDay ? bestOpt.src : rate.source;
    if (a.steps && !fresh.newDay) {
      // Multi-step crimes: rank by what the next step is worth, not the crime's lifetime average.
      const s0 = a.steps.find(s => !s.wait);
      if (s0 && s0.perN !== null && s0.perN !== undefined) { nowRate = s0.perN; nowSrc = s0.deferred ? 'next step, pays later' : 'next step'; }
      else if (s0) { nowSrc = 'next step has no direct payout'; }
    }
    return { typeID, name: CRIMES[typeID], rate: nowRate, crimeRate: rate.rate, source: nowSrc, seenAt: st && st.seenAt,
      stale: !!fresh.stale && !fresh.newDay, newDay: !!fresh.newDay, noPick, ...a };
  });
  // Things you can act on first, then estimates that can't be the top pick, then the rest; best $/N first within each.
  const tier = r => (r.actionable ? (r.noPick ? 1 : 2) : 0);
  rows.sort((x, y) => (tier(y) - tier(x)) || ((y.rate ?? -1e12) - (x.rate ?? -1e12)));
  const top = rows.find(r => r.actionable && !r.noPick && r.rate !== null && r.rate > 0) || null;
  rows.forEach(r => {
    if (!top || r === top) return;
    if (!r.actionable) r.why = 'nothing to do right now';
    else if (r.rate === null) r.why = r.source;
    else if (r.rate <= 0) r.why = 'has lost money overall';
    else if (r.noPick) r.why = r.typeID === 11 ? 'estimate leaves out material costs' : 'wiki estimate; needs a few of your own tries first';
    else {
      const x = top.rate / r.rate;
      r.why = x < 1.5 ? `${top.name} pays ${Math.round((x - 1) * 100)}% more per nerve` : `${top.name} pays ~${Math.round(x)}× more per nerve`;
    }
  });
  return { top, rows };
}
