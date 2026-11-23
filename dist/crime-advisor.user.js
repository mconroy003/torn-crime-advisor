// ==UserScript==
// @name         Torn Crime Advisor
// @namespace    mason.crime-advisor
// @version      0.2.0
// @description  Read-only crime advisor for Torn Crimes 2.0: ranks crimes by your real cash per nerve and picks the best option on each crime page. Never clicks or sends requests.
// @match        https://www.torn.com/loader.php?sid=crimes*
// @match        https://www.torn.com/page.php?sid=crimes*
// @run-at       document-start
// @grant        none
// @updateURL    https://raw.githubusercontent.com/mconroy003/torn-crime-advisor/main/dist/crime-advisor.user.js
// @downloadURL  https://raw.githubusercontent.com/mconroy003/torn-crime-advisor/main/dist/crime-advisor.user.js
// ==/UserScript==

(function () {
'use strict';
// ---------- core: constants, storage, clock, formatting ----------

const CRIMES = {
  1: 'Search for Cash', 2: 'Bootlegging', 3: 'Graffiti', 4: 'Shoplifting',
  5: 'Pickpocketing', 6: 'Card Skimming', 7: 'Burglary', 8: 'Hustling',
  9: 'Disposal', 10: 'Cracking', 11: 'Forgery', 12: 'Scamming', 13: 'Arson',
};
const ROUTES = {
  searchforcash: 1, bootlegging: 2, graffiti: 3, shoplifting: 4, pickpocketing: 5,
  cardskimming: 6, burglary: 7, hustling: 8, disposal: 9, cracking: 10,
  forgery: 11, scamming: 12, arson: 13,
};

// Nerve that must be spent since install before "recent" $/N replaces lifetime $/N.
const MIN_RECENT_NERVE = 60;
const MAX_LOG = 400;

const Store = {
  key: 'crimeAdvisor.v1',
  _cache: null,
  load() {
    if (this._cache) return this._cache;
    let data = {};
    try { data = JSON.parse(localStorage.getItem(this.key)) || {}; } catch { data = {}; }
    data.state = data.state || {};       // typeID -> { seenAt, db }   (last crimesList DB, trimmed)
    data.base = data.base || {};         // typeID -> { money, nerve, at } first snapshot after install
    data.last = data.last || {};         // typeID -> { money, nerve, at } latest snapshot
    data.actions = data.actions || {};   // crimeID -> { n, money, nerve, title }
    data.outages = data.outages || {};   // "store|effect" -> firstSeenDown (ms)
    data.log = data.log || [];
    this._cache = data;
    return data;
  },
  save() {
    try { localStorage.setItem(this.key, JSON.stringify(this._cache)); }
    catch (e) { console.warn('[CrimeAdvisor] could not save', e); }
  },
  reset() { this._cache = null; localStorage.removeItem(this.key); },
};

// Torn City Time is UTC.
const TCT = {
  now() { return new Date(); },
  label(d = new Date()) { return d.toISOString().slice(11, 16) + ' TCT'; },
};

const fmt = {
  money(n) {
    if (n === null || n === undefined || Number.isNaN(n)) return '–';
    const sign = n < 0 ? '-' : '';
    const a = Math.abs(n);
    if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
    if (a >= 1e4) return `${sign}$${Math.round(a / 1e3)}k`;
    return `${sign}$${Math.round(a).toLocaleString('en-US')}`;
  },
  perN(n) { return n === null || n === undefined ? '–' : `${fmt.money(n)}/N`; },
  ago(ms) {
    if (!ms) return 'never seen';
    const m = Math.round((Date.now() - ms) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
  },
  dur(sec) {
    if (sec <= 0) return 'now';
    const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
    return h ? `${h} h ${m} m` : `${m} m`;
  },
};

// Success rate with a light prior so 1/1 doesn't read as 100%.
function successRate(stats, crimeID) {
  const att = (stats && stats.crimesByIDAttempts && stats.crimesByIDAttempts[crimeID]) || 0;
  const suc = (stats && stats.crimesByIDAttemptsSucc && stats.crimesByIDAttemptsSucc[crimeID]) || 0;
  return { p: (suc + 4) / (att + 5), att, suc };
}

// ---------- data: read the crime data the page already loads ----------
// Read-only. Never sends requests to Torn, never clicks anything.

function parseRequest(url, body) {
  const u = new URL(url, 'https://www.torn.com');
  const step = u.searchParams.get('step') || '';
  let typeID = u.searchParams.get('typeID');
  if (!typeID && body) {
    try { typeID = JSON.parse(body).typeID; } catch { /* not JSON */ }
    if (!typeID) { const m = String(body).match(/typeID["=:\s]*"?(\d+)/); if (m) typeID = m[1]; }
  }
  return { step, typeID: typeID ? Number(typeID) : null, crimeID: u.searchParams.get('crimeID') };
}

function trimDB(db) {
  const cbt = db.crimesByType ? JSON.parse(JSON.stringify(db.crimesByType)) : null;
  if (cbt && cbt.rig) delete cbt.rig.chassis;           // big heat maps, not needed
  return {
    crimesByType: cbt,
    generalInfo: db.generalInfo || null,
    dirtyBomb: db.dirtyBomb || null,
    stats: db.currentUserStats ? {
      moneyFoundTotal: db.currentUserStats.moneyFoundTotal,
      nerveUsed: db.currentUserStats.nerveUsed,
      crimesByIDAttempts: db.currentUserStats.crimesByIDAttempts,
      crimesByIDAttemptsSucc: db.currentUserStats.crimesByIDAttemptsSucc,
      cardsRecoverable: db.currentUserStats.cardsRecoverable,
      skimmersActive: db.currentUserStats.skimmersActive,
    } : null,
  };
}

// Earnings: compare cash and nerve totals between snapshots.
function recordSnapshot(data, typeID, stats, crimeID, now) {
  if (!stats || typeof stats.nerveUsed !== 'number') return;
  const money = typeof stats.moneyFoundTotal === 'number' ? stats.moneyFoundTotal : null;
  const snap = { money, nerve: stats.nerveUsed, at: now };
  const prev = data.last[typeID];
  if (!data.base[typeID]) data.base[typeID] = snap;

  // Attribute the change to this action when one attempt explains it.
  if (crimeID && prev && money !== null && prev.money !== null) {
    const dN = snap.nerve - prev.nerve, dM = money - prev.money;
    if (dN > 0 && dN <= 60) {
      const key = `${typeID}:${crimeID}`;
      const a = data.actions[key] || { n: 0, money: 0, nerve: 0 };
      a.n += 1; a.money += dM; a.nerve += dN;
      data.actions[key] = a;
      data.log.unshift({ at: now, typeID, crimeID, dM, dN });
      data.log.length = Math.min(data.log.length, MAX_LOG);
    }
  }
  data.last[typeID] = snap;
}

function handleResponse(url, body, json, now = Date.now()) {
  if (!url || !String(url).includes('sid=crimesData') || !json || !json.DB) return false;
  const { step, typeID, crimeID } = parseRequest(url, body);
  const db = json.DB;
  const data = Store.load();
  if (db.user && typeof db.user.nerve === 'number') data.user = { nerve: db.user.nerve, at: now };
  if (step === 'hub' && db.crimesTypes) data.hubSeenAt = now;
  if (typeID && db.crimesByType) data.state[typeID] = { seenAt: now, db: trimDB(db) };
  if (typeID && db.currentUserStats) {
    recordSnapshot(data, typeID, db.currentUserStats, step === 'attempt' ? crimeID : null, now);
  }
  Store.save();
  return true;
}

function installHooks(win, onChange) {
  const origFetch = win.fetch;
  win.fetch = async function (resource, config) {
    const res = await origFetch.apply(this, arguments);
    try {
      const url = typeof resource === 'string' ? resource : resource && resource.url;
      if (url && String(url).includes('sid=crimesData')) {
        const body = config && typeof config.body === 'string' ? config.body : null;
        res.clone().json().then(j => { if (handleResponse(url, body, j)) onChange(); }).catch(() => {});
      }
    } catch { /* never break the page */ }
    return res;
  };
  const P = win.XMLHttpRequest.prototype, open = P.open, send = P.send;
  P.open = function (m, url) { this._caUrl = url; return open.apply(this, arguments); };
  P.send = function (body) {
    if (this._caUrl && String(this._caUrl).includes('sid=crimesData')) {
      this.addEventListener('load', () => {
        try { if (handleResponse(String(this._caUrl), typeof body === 'string' ? body : null, JSON.parse(this.responseText))) onChange(); }
        catch { /* not JSON */ }
      });
    }
    return send.apply(this, arguments);
  };
}

// $/N for a crime: recent (since install) when enough nerve is spent, else lifetime.
function crimeRate(data, typeID) {
  const last = data.last[typeID], base = data.base[typeID];
  if (!last || last.money === null) return { rate: null, source: last ? 'pays items' : 'not seen' };
  if (base && last.nerve - base.nerve >= MIN_RECENT_NERVE) {
    return { rate: (last.money - base.money) / (last.nerve - base.nerve), source: `recent, ${last.nerve - base.nerve}N` };
  }
  return { rate: last.nerve > 0 ? last.money / last.nerve : null, source: 'lifetime' };
}

// Learned $/attempt for one action, if we've seen enough of it.
function actionValue(data, typeID, crimeID, minN = 3) {
  const a = data.actions[`${typeID}:${crimeID}`];
  if (!a || a.n < minN) return null;
  return { perAttempt: a.money / a.n, perNerve: a.nerve ? a.money / a.nerve : null, n: a.n };
}

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
    const opts = (cbt.targets || []).filter(t => !t.isCracked).map(t => {
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

  1(db) { // Search for Cash
    const locs = (Array.isArray(db.crimesByType) ? db.crimesByType : []).map(c => {
      const a = c.additionalInfo || {};
      return { key: c.title, short: `${a.barValue ?? '?'}%`, label: c.title.replace('Search the ', ''), detail: `${a.barValue ?? '?'}% · ${a.title || ''}`, sort: a.barValue || 0 };
    }).sort((a, b) => b.sort - a.sort);
    if (locs.length) locs[0].best = true;
    return { actionable: true, note: locs.length ? `Best now: ${locs[0].label} (${locs[0].sort}%)` : '', options: locs };
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
    const props = (db.crimesByType && db.crimesByType.properties) || [];
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
    let a = { actionable: false, note: 'Open this crime once so the Advisor can read it', options: [] };
    if (st && Analyzers[typeID]) {
      try { a = Analyzers[typeID](st.db, data); } catch (e) { a = { actionable: false, note: 'Could not read this crime: ' + e.message, options: [] }; }
    }
    return { typeID, name: CRIMES[typeID], rate: rate.rate, source: rate.source, seenAt: st && st.seenAt, ...a };
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

// ---------- ui: small labels on Torn's own page, like Crime Profitability ----------
// Hub: a $/N badge on every crime card, ★ on the best one.
// Crime pages: ★ + reason on the best option, plus one line under the page header.
// Built with textContent only; re-applied every second because React re-renders rows.

const CSS = `
.ca-badge{display:inline-block;margin:0 6px;padding:1px 6px;border-radius:9px;font-size:11px;font-weight:bold;
  line-height:16px;background:rgba(127,127,127,.18);color:inherit;white-space:nowrap;vertical-align:middle}
.ca-badge.ca-good{background:#3c8d4f;color:#fff}
.ca-badge.ca-bad{background:rgba(224,122,122,.25)}
.ca-pick{outline:2px solid #3c8d4f !important;outline-offset:-2px;border-radius:5px}
.ca-line{padding:6px 10px;margin:6px 0;font-size:12px;border-left:3px solid #3c8d4f;background:rgba(60,141,79,.12);border-radius:3px}
`;

function h(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined && text !== null) el.textContent = text;
  return el;
}
const norm = s => String(s || '').toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();

function currentCrime() {
  const href = location.href.toLowerCase();
  for (const [route, id] of Object.entries(ROUTES)) if (href.includes('/' + route) || href.includes('#' + route)) return id;
  return null; // Crime Hub
}

// Set or create one badge inside `host`, keyed so we update instead of re-adding.
function badge(host, key, text, cls, before) {
  if (!host) return;
  let b = Array.from(host.children).find(c => c.classList.contains('ca-badge') && c.dataset.ca === key);
  if (!text) { if (b) b.remove(); return; }
  if (!b) {
    b = h('span', 'ca-badge'); b.dataset.ca = key;
    if (before && before.parentNode === host) host.insertBefore(b, before); else host.appendChild(b);
  }
  const c = 'ca-badge' + (cls ? ' ' + cls : '');
  if (b.className !== c) b.className = c;
  if (b.textContent !== text) b.textContent = text;
}

function rowTitle(row) {
  for (const sel of ['[class*="titleAndProps__"] div', '[class*="tabletShopTitle__"]', '[class*="titleAndIcon__"]',
    '[class*="tabletProjectTitle__"]', '[class*="tabletTitleAndTagCount__"]']) {
    const el = row.querySelector(sel); if (el && el.textContent.trim()) return norm(el.textContent);
  }
  for (const n of row.childNodes) if (n.nodeType === 3 && n.textContent.trim()) return norm(n.textContent);
  const t = row.querySelector('[class*="title__"]'); if (t) return norm(t.textContent);
  return norm(row.textContent).slice(0, 40);
}

const UI = {
  mounted: false,

  mount() {
    if (this.mounted || !document.head) return;
    this.mounted = true;
    const style = h('style'); style.textContent = CSS; document.head.appendChild(style);
    setInterval(() => this.render(), 1000);
    this.render();
  },

  render() {
    if (!this.mounted) return;
    try {
      const data = Store.load();
      const ranking = rankAll(data);
      const here = currentCrime();
      if (here) this.crimePage(here, ranking); else this.hub(ranking);
      Store.save();
    } catch (e) { console.warn('[CrimeAdvisor]', e); }
  },

  // ---- Crime Hub: one badge per card ----
  hub({ top, rows }) {
    document.querySelectorAll('.crimes-hub-root a, .crimes-hub-crime').forEach(card => {
      const titleEl = card.querySelector('[class*="crimeTitle__"]');
      if (!titleEl) return;
      const r = rows.find(x => norm(x.name) === norm(titleEl.textContent));
      if (!r) return;
      const host = card.querySelector('[class*="titleBar__"]') || titleEl.parentNode;
      const isTop = !!top && r.typeID === top.typeID;
      const txt = r.rate !== null ? `${isTop ? '★ ' : ''}${fmt.perN(r.rate)}` : (r.seenAt ? r.source : 'open once');
      badge(host, 'rate', txt, isTop ? 'ca-good' : (r.rate !== null && r.rate < 0 ? 'ca-bad' : ''), host.firstChild);
      card.classList.toggle('ca-pick', isTop);
      const tip = [r.note, r.why].filter(Boolean).join(' · ');
      if (card.title !== tip) card.title = tip;
    });
  },

  // ---- Crime pages ----
  crimePage(typeID, { top, rows }) {
    const r = rows.find(x => x.typeID === typeID);
    if (!r) return;

    // One line under the header: your $/N here, the best crime now, and this crime's status.
    const header = document.querySelector('.crimes-app-header') || document.querySelector('.content-title');
    if (header && header.parentNode) {
      let line = document.getElementById('ca-line');
      if (!line) { line = h('div', 'ca-line'); line.id = 'ca-line'; }
      if (line.previousElementSibling !== header) header.parentNode.insertBefore(line, header.nextSibling);
      const parts = [`Your ${r.name}: ${fmt.perN(r.rate)} (${r.source})`];
      if (top && top.typeID !== typeID) parts.push(`Best now: ${top.name} ${fmt.perN(top.rate)}`);
      else if (top) parts.push('★ Best crime right now');
      const text = parts.join(' · ') + (r.note ? ` — ${r.note}` : '');
      if (line.textContent !== text) line.textContent = text;
    }

    const optRows = Array.from(document.querySelectorAll('[class*="crimeOptionSection__"]'));
    if (!optRows.length || !r.options || !r.options.length) return;
    if (typeID === 9) return this.disposal(optRows, r);
    if (typeID === 10) return this.cracking(optRows, r);

    // Default: match rows to options by title.
    optRows.forEach(row => {
      const t = rowTitle(row);
      const o = r.options.find(x => t.startsWith(norm(x.key)));
      if (!o) { badge(row, 'opt', null); return; }
      badge(row, 'opt', (o.best ? '★ ' : '') + o.short, o.best ? 'ca-good' : '', row.childNodes[1] || null);
      if (row.title !== o.detail) row.title = o.detail;
    });
  },

  // Disposal: outline the best method button on each job.
  disposal(optRows, r) {
    optRows.forEach(row => {
      const t = rowTitle(row);
      const o = r.options.find(x => t.startsWith(norm(x.key)));
      row.querySelectorAll('[class*="methodButton__"]').forEach(btn => {
        const isBest = !!o && norm(btn.getAttribute('aria-label')).includes(norm(o.method));
        btn.classList.toggle('ca-pick', isBest);
      });
      badge(row, 'opt', o ? (o.best ? '★ ' : '') + o.short : null, o && o.best ? 'ca-good' : '', row.childNodes[1] || null);
      if (o && row.title !== o.detail) row.title = o.detail;
    });
  },

  // Cracking: match rows by service name.
  cracking(optRows, r) {
    optRows.forEach(row => {
      const svc = row.querySelector('[class*="service__"]');
      const o = svc && r.options.find(x => norm(x.service) === norm(svc.textContent));
      badge(row, 'opt', o ? (o.best ? '★ ' : '') + o.short : null, o && o.best ? 'ca-good' : '');
      if (o && row.title !== o.detail) row.title = o.detail;
    });
  },
};

// ---------- main ----------
const pageWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
installHooks(pageWin, () => UI.render());
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => UI.mount());
else UI.mount();

})();
