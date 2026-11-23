// ---------- crimes: one analyzer per crime ----------
// Each returns { actionable, note, options: [{ label, detail, best }] }.
// Cross-crime ranking uses measured $/N (crimeRate); analyzers pick the best option inside a crime.

// Cracking payout ranges from the Torn wiki (Cracking page), keyed by target title.
const CRACK_PAYOUT = {
  'colleague': [10e3, 30e3], 'ex-boyfriend': [10e3, 30e3], 'ex-girlfriend': [10e3, 30e3],
  'ex-husband': [10e3, 30e3], 'ex-wife': [10e3, 30e3], 'online adversary': [10e3, 30e3],
  'romantic interest': [10e3, 30e3], 'friend': [10e3, 25e3], 'neighbor': [10e3, 25e3], 'neighbour': [10e3, 25e3],
  'informant': [30e3, 50e3], 'juror': [30e3, 50e3], 'doctor': [35e3, 140e3], 'judge': [40e3, 99.6e3],
  'hacker': [50e3, 199.8e3], 'police officer': [40e3, 90e3], 'government official': [70e3, 130e3],
  'politician': [60e3, 119.9e3], 'pornography network': [80.5e3, 149.8e3], 'campus network': [60e3, 180e3],
  'health service': [80.1e3, 150e3], 'games developer': [60.1e3, 149e3], 'rival corporation': [80.1e3, 250e3],
  'police department': [100.3e3, 250e3], 'criminal syndicate': [100.3e3, 348.5e3], 'government': [150.2e3, 499.4e3],
  'internet service provider': [175e3, 294.9e3], 'armed forces': [400e3, 749.8e3], 'intelligence agency': [402.6e3, 997.6e3],
};

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

const Analyzers = {
  9(db, data) { // Disposal
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
      return {
        key: job.title, method: best.m.title,
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
      note: opts.length ? `${opts.length} jobs open · start with ${opts[0].label}` : 'No jobs left today; new ones spawn at 00:00 TCT',
      options: opts,
    };
  },

  10(db) { // Cracking
    const cbt = db.crimesByType || {};
    const brute = successRate(db.stats, 205).p;
    // Each brute-force attempt clears about "bruteforcePower" characters/layers (your stats: ~3 attempts per password).
    const power = Math.max(1, parseFloat(cbt.rig && cbt.rig.bruteforcePower) || 1);
    const opts = (cbt.targets || []).filter(t => !t.isCracked && !(t.expire && t.expire * 1000 < Date.now())).map(t => {
      const chars = t.password || [];
      const units = chars.reduce((s, c) => s + ((c.char && c.char !== '*') ? 0 : (c.status || 0)), 0);
      const revealed = chars.some(c => c.char && c.char !== '*');
      const nerve = Math.round(Math.ceil(units / power) * 7 / brute + 5);
      const range = CRACK_PAYOUT[String(t.title).toLowerCase()];
      const mid = range ? (range[0] + range[1]) / 2 : null;
      const perN = mid ? mid / nerve : null;
      return {
        service: t.service,
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
        opts.length ? `${opts.length} targets · next: ${opts[0].label}` : 'No targets left; new ones at 00:00 TCT',
      options: opts,
    };
  },

  4(db, data) { // Shoplifting
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
      return {
        key: s.title,
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
      note: open.length ? `All security down at ${open.join(', ')}` : 'No store has all security down',
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

  2(db) { // Bootlegging
    const gi = db.generalInfo || {};
    const subs = Array.isArray(db.crimesByType) ? db.crimesByType : [];
    const store = subs.find(c => c.title === 'Online Store');
    const copy = subs.find(c => c.title === 'Copy DVDs');
    const stock = Object.values(gi.CDs || {}).reduce((s, n) => s + n, 0);
    const empty = Object.values(gi.CDs || {}).filter(n => !n).length;
    const toCollect = store && store.additionalInfo ? store.additionalInfo.moneyToCollect : 0;
    const blanks = copy && copy.additionalInfo ? copy.additionalInfo.blankCDs : null;
    const notes = [];
    if (toCollect > 0) notes.push(`Collect ${fmt.money(toCollect)} from the store (1N)`);
    if (store && store.additionalInfo && store.additionalInfo.enabled && stock === 0) notes.push(`Store is on but has no stock${blanks !== null ? ` (${blanks} blank DVDs)` : ''}`);
    else if (empty) notes.push(`${empty} of 8 genres out of stock`);
    return { actionable: toCollect > 0 || (stock === 0 && blanks > 0), note: notes.join(' · ') || `${stock} DVDs in stock`, options: [] };
  },

  3(db) { // Graffiti
    const d = (Array.isArray(db.crimesByType) ? db.crimesByType : []).map(c => (c.additionalInfo || {}).reputation || 0);
    return { actionable: true, note: d.length ? `Lowest district reputation: ${Math.min(...d)} stars` : '', options: [] };
  },

  5() { return { actionable: true, note: 'Targets are live; check the page for good ones', options: [] }; },

  6(db) { // Card Skimming
    const s = db.stats || {};
    return { actionable: (s.cardsRecoverable || 0) > 0, note: `${s.skimmersActive ?? '?'} skimmers active · ${s.cardsRecoverable ?? 0} card details recoverable`, options: [] };
  },

  7(db) { // Burglary
    const props = ((db.crimesByType && db.crimesByType.properties) || []).filter(p => !(p.expire && p.expire * 1000 < Date.now()));
    const soon = props.filter(p => p.expiresSoon).length;
    const opts = props.map(p => ({
      key: p.title,
      short: `${p.confidence}% confidence` + (p.recommendedItem && !p.recommendedItem.owned ? ` · missing ${p.recommendedItem.title}` : '') + (p.expiresSoon ? ' · expiring' : ''),
      label: p.title,
      detail: `confidence ${p.confidence}% · ${p.safetyStatus}` +
        (p.recommendedItem ? ` · needs ${p.recommendedItem.title}${p.recommendedItem.owned ? ' (owned)' : ' (MISSING)'}` : '') +
        ` · expires in ${fmt.dur(p.expire - Date.now() / 1000)}`,
      sort: (p.safetyStatus === 'safe' ? 1000 : 0) + p.confidence,
    })).sort((a, b) => b.sort - a.sort);
    if (opts.length) opts[0].best = true;
    return { actionable: props.length > 0, note: `${props.length} targets scouted${soon ? ` · ${soon} expiring soon` : ''}`, options: opts };
  },

  8(db) { // Hustling
    const c = db.crimesByType || {};
    const sh = (c.shill && c.shill.additionalInfo && c.shill.additionalInfo.moneyToCollect) || 0;
    const pp = (c.pickpocket && c.pickpocket.additionalInfo && c.pickpocket.additionalInfo.moneyToCollect) || 0;
    return { actionable: true, note: sh + pp > 0 ? `Collect ${fmt.money(sh + pp)} from accomplices (2N each)` : 'Nothing to collect from accomplices', options: [] };
  },

  11(db) { // Forgery
    const c = db.crimesByType || {};
    const n = (c.projects || []).length;
    return { actionable: n > 0, note: `${n} projects active · pays in items (needs item prices)`, options: [] };
  },

  12(db) { // Scamming
    const c = db.crimesByType || {};
    const t = (c.targets || []).length;
    return {
      actionable: true,
      note: t ? `${t} targets need replies${c.awaitingResponses ? ' · awaiting responses' : ''}`
        : `No targets: launch a spam wave (8N) · ${(c.farmedEmails || 0).toLocaleString('en-US')} emails`,
      options: [],
    };
  },

  13(db) { // Arson
    const jobs = (db.crimesByType && db.crimesByType.targets) || [];
    const collect = jobs.filter(j => (j.availableActions || []).some(a => /collect/i.test(a.title))).length;
    return {
      actionable: jobs.length > 0,
      note: `${jobs.length} jobs${collect ? ` · ${collect} ready to Collect (2N, can't fail)` : ''}`,
      options: [],
    };
  },
};

// Build the ranked list across all crimes.
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
      try { a = Analyzers[typeID](st.db, data, { now, fresh }); } catch (e) { a = { actionable: false, note: 'Could not read this crime: ' + e.message, options: [] }; }
      if (fresh.stale) a.note = `${a.note} (as of ${fmt.ago(st.seenAt)})`;
    }
    if (DAILY[typeID] && st && !fresh.newDay && !a.actionable) {
      a.note = `${a.note} · next ${DAILY[typeID]} in ${fmt.dur((lastTctMidnight(now) + 86400000 - now) / 1000)}`;
    }
    return { typeID, name: CRIMES[typeID], rate: rate.rate, source: rate.source, seenAt: st && st.seenAt,
      stale: !!fresh.stale && !fresh.newDay, newDay: !!fresh.newDay, ...a };
  });
  rows.sort((x, y) => (y.actionable - x.actionable) || ((y.rate ?? -1e12) - (x.rate ?? -1e12)));
  const top = rows.find(r => r.actionable && r.rate !== null && r.rate > 0) || null;
  rows.forEach(r => {
    if (!top || r === top) return;
    if (!r.actionable) r.why = 'nothing to do right now';
    else if (r.rate === null) r.why = r.source;
    else if (r.rate <= 0) r.why = 'has lost money overall';
    else {
      const x = top.rate / r.rate;
      r.why = x < 1.5 ? `${top.name} pays ${Math.round((x - 1) * 100)}% more per nerve` : `${top.name} pays ~${Math.round(x)}× more per nerve`;
    }
  });
  return { top, rows };
}
