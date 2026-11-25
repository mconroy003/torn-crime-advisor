// ==UserScript==
// @name         Torn Crime Advisor
// @namespace    mason.crime-advisor
// @version      0.9.0
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

// ---------- reference: public payout ranges from the Torn wiki ----------
// Starting estimates only. Each option moves toward your own results as you play (see blend()).
// Sources: wiki.torn.com pages for Cracking, Pickpocketing, Burglary and Forgery (read Nov 2026).

const REF = {
  // Cracking target → cash range
  cracking: {
    'colleague': [10e3, 30e3], 'ex-boyfriend': [10e3, 30e3], 'ex-girlfriend': [10e3, 30e3],
    'ex-husband': [10e3, 30e3], 'ex-wife': [10e3, 30e3], 'online adversary': [10e3, 30e3],
    'romantic interest': [10e3, 30e3], 'friend': [10e3, 25e3], 'neighbor': [10e3, 25e3], 'neighbour': [10e3, 25e3],
    'informant': [30e3, 50e3], 'juror': [30e3, 50e3], 'doctor': [35e3, 140e3], 'judge': [40e3, 99.6e3],
    'hacker': [50e3, 199.8e3], 'police officer': [40e3, 90e3], 'government official': [70e3, 130e3],
    'politician': [60e3, 119.9e3], 'pornography network': [80.5e3, 149.8e3], 'campus network': [60e3, 180e3],
    'health service': [80.1e3, 150e3], 'games developer': [60.1e3, 149e3], 'rival corporation': [80.1e3, 250e3],
    'police department': [100.3e3, 250e3], 'criminal syndicate': [100.3e3, 348.5e3], 'government': [150.2e3, 499.4e3],
    'internet service provider': [175e3, 294.9e3], 'armed forces': [400e3, 749.8e3], 'intelligence agency': [402.6e3, 997.6e3],
  },
  // Pickpocketing mark → cash range (items extra). Mobster and Police Officer cash unknown.
  pickpocketing: {
    'businessman': [1380, 9600], 'businesswoman': [1100, 6000], 'classy lady': [1020, 79400], 'cyclist': [720, 10400],
    'drunk man': [216, 3769], 'drunk woman': [274, 3380], 'elderly man': [460, 5000], 'elderly woman': [460, 4900],
    'gang member': [1660, 7000], 'homeless person': [70, 2921], 'jogger': [560, 4550], 'junkie': [202, 4800],
    'laborer': [560, 4700], 'postal worker': [746, 5792], 'rich kid': [1200, 8000], 'sex worker': [530, 5600],
    'student': [312, 3631], 'thug': [800, 6000], 'young man': [550, 3970], 'young woman': [830, 4960],
  },
  // Burglary property → cash range (items extra). Only properties with a full range on the wiki.
  burglary: {
    'advertising agency': [31522, 76200], 'advertisement agency': [31522, 76200], 'barbershop': [10348, 49866],
    'cleaning agency': [10300, 59450], 'dentists office': [5070, 58900], 'funeral parlor': [5150, 49290],
    'liquor store': [5204, 49180], 'market': [10160, 68500], 'self-storage facility': [10200, 69920],
    'brewery': [5406, 23880], 'farm storage unit': [6670, 79200], 'paper mill': [10580, 59780],
    'printing works': [5030, 149700], 'truckyard': [5578, 146600],
  },
  // Forgery project → Print Store sale price (materials not included)
  forgery: {
    'concert ticket': 3250, 'parking permit': 6500, "driver's license": 5000, 'diploma': 50000,
    'birth certificate': 62500, 'license plate': 95000, 'skeleton key': 80000, 'prescription': 75000,
    'travel visa': 122500, 'bank check': 180000, 'police badge': 230000, 'passport': 580000,
  },
};

const mid = r => (r ? (r[0] + r[1]) / 2 : null);

// Move from the starting estimate toward your own $/N: half-way after 5 attempts, ~2/3 after 10.
function blend(priorPerN, learned) {
  if (!learned || learned.perNerve === null) return { perN: priorPerN, src: priorPerN === null ? 'unknown' : 'estimate' };
  if (priorPerN === null) return { perN: learned.perNerve, src: `yours, ${learned.n} tries` };
  const w = learned.n / (learned.n + 5);
  return { perN: w * learned.perNerve + (1 - w) * priorPerN, src: `${Math.round(w * 100)}% yours, ${learned.n} tries` };
}

// ---------- prices: item market values from the Torn API (optional, needs your key) ----------
// The key is kept in this browser only and sent only to api.torn.com. Prices are cached for 6 hours.

const KEY_STORE = 'crimeAdvisor.apiKey';
const PRICE_STORE = 'crimeAdvisor.prices';
const PRICE_TTL = 6 * 3600 * 1000;

const Prices = {
  byId: {}, byName: {}, fetchedAt: 0, error: '', loading: false,

  key() { try { return localStorage.getItem(KEY_STORE) || ''; } catch { return ''; } },
  setKey(k) {
    k = String(k || '').trim();
    if (k) localStorage.setItem(KEY_STORE, k); else localStorage.removeItem(KEY_STORE);
    localStorage.removeItem(PRICE_STORE);
    this.byId = {}; this.byName = {}; this.fetchedAt = 0; this.error = '';
  },

  load() {
    if (this.fetchedAt) return;
    try {
      const c = JSON.parse(localStorage.getItem(PRICE_STORE) || 'null');
      if (c && c.at) this.ingest(c.items, c.at);
    } catch { /* ignore */ }
  },

  // Accepts API v1 ({items:{id:{name, market_value}}}) or v2 ({items:[{id, name, value:{market_price}}]}).
  ingest(items, at) {
    const byId = {}, byName = {};
    const list = Array.isArray(items) ? items : Object.entries(items || {}).map(([id, v]) => ({ id: Number(id), ...v }));
    for (const it of list) {
      const price = it.market_value ?? (it.value && (it.value.market_price ?? it.value.market_value)) ?? null;
      const sell = it.sell_price ?? (it.value && it.value.sell_price) ?? null;
      if (!it.name) continue;
      const rec = { id: Number(it.id), name: it.name, price: price || null, sell: sell || null };
      byId[rec.id] = rec; byName[it.name.toLowerCase()] = rec;
    }
    this.byId = byId; this.byName = byName; this.fetchedAt = at;
  },

  async refresh(fetchFn) {
    const key = this.key();
    this.load();
    if (!key || this.loading || (this.fetchedAt && Date.now() - this.fetchedAt < PRICE_TTL)) return false;
    this.loading = true;
    try {
      const res = await fetchFn(`https://api.torn.com/torn/?selections=items&key=${encodeURIComponent(key)}&comment=CrimeAdvisor`);
      const j = await res.json();
      if (j.error) throw new Error(`API error ${j.error.code}: ${j.error.error}`);
      this.ingest(j.items, Date.now());
      localStorage.setItem(PRICE_STORE, JSON.stringify({ at: this.fetchedAt, items: j.items }));
      this.error = '';
      return true;
    } catch (e) {
      this.error = e.message;
      return false;
    } finally { this.loading = false; }
  },

  ready() { this.load(); return Object.keys(this.byId).length > 0; },
  of(idOrName) {
    this.load();
    const r = typeof idOrName === 'number' ? this.byId[idOrName] : this.byName[String(idOrName).toLowerCase()];
    return r && r.price ? r.price : null;
  },
};

// Consumables per Forgery project (Torn wiki, Forgery page). Quantity isn't listed there, so 1 per use is assumed.
const FORGERY_CONSUMABLES = {
  Passport: { 'Cardstock': 1, 'Bonded Latex': 1, 'Glue': 2, 'Toner': 1, 'Bond Paper': 1, 'Adhesive Plastic': 1 },
  'Police Badge': { 'Brass Ingot': 1, 'Crushed Enamel': 1, 'Blowtorch': 1 },
  'Bank Check': { 'Bank Statement': 1, 'Toner': 1, 'Bond Paper': 1, 'Inkwell': 1 },
};

function materialCostFromPrices(project) {
  const list = FORGERY_CONSUMABLES[project];
  if (!list || !Prices.ready()) return null;
  let total = 0; const missing = [];
  for (const [name, qty] of Object.entries(list)) {
    const p = Prices.of(name);
    if (p === null) missing.push(name); else total += p * qty;
  }
  return { total, missing };
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
    // Every number in your stats, plus per-action attempts and successes.
    stats: db.currentUserStats ? Object.fromEntries(Object.entries(db.currentUserStats).filter(([k, v]) =>
      typeof v === 'number' || k === 'crimesByIDAttempts' || k === 'crimesByIDAttemptsSucc')) : null,
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

  // First snapshot of each TCT day, kept for 60 days, for the rolling recent rate.
  const day = Math.floor(now / 86400000);
  data.daily = data.daily || {};
  const list = data.daily[typeID] = data.daily[typeID] || [];
  if (!list.length || list[list.length - 1].day !== day) list.push({ day, money, nerve: snap.nerve });
  while (list.length > 60) list.shift();
}

const Diag = { hooked: false, seen: 0, read: 0, fromPage: 0, lastStep: '', lastError: '', pageLoadedAt: Date.now() };

const isPlainObj = v => v && typeof v === 'object' && !Array.isArray(v);

// Last raw response per crime and step, for troubleshooting. Run crimeAdvisorExport() in the console to download.
const RAW_KEY = 'crimeAdvisor.raw';
function saveRaw(typeID, step, json) {
  try {
    const raw = JSON.parse(localStorage.getItem(RAW_KEY) || '{}');
    const copy = JSON.parse(JSON.stringify(json));
    const cbt = copy.DB && copy.DB.crimesByType;
    if (cbt && cbt.rig) delete cbt.rig.chassis;
    if (copy.DB) { delete copy.DB.apiKey; delete copy.DB.currentUserStatistics; delete copy.DB.allowedCrimesTypes; }
    raw[`${typeID}:${step}`] = { at: new Date().toISOString(), response: copy };
    localStorage.setItem(RAW_KEY, JSON.stringify(raw));
  } catch { /* storage full: skip */ }
}
function setSetting(kind, name, value) {
  const data = Store.load();
  data.settings = data.settings || {};
  data.settings[kind] = data.settings[kind] || {};
  if (value === null || value === undefined) delete data.settings[kind][name]; else data.settings[kind][name] = Number(value);
  Store.save();
  return data.settings;
}
function exportRaw() {
  const blob = new Blob([JSON.stringify({ raw: JSON.parse(localStorage.getItem(RAW_KEY) || '{}'), advisor: Store.load() }, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `crime-advisor-export-${new Date().toISOString().slice(0, 16).replace(':', '')}.json`;
  document.body.appendChild(a); a.click(); a.remove();
}

function handleResponse(url, body, json, now = Date.now()) {
  if (!url || !String(url).includes('sid=crimesData')) return false;
  Diag.seen += 1;
  if (!json || !json.DB) { Diag.lastError = 'response had no DB'; return false; }
  const { step, typeID, crimeID } = parseRequest(url, body);
  Diag.lastStep = `${step}${typeID ? ' #' + typeID : ''}`;
  if (typeID) Diag.read += 1;
  console.log('[CrimeAdvisor] read', Diag.lastStep);
  const db = json.DB;
  const data = Store.load();
  if (db.user && typeof db.user.nerve === 'number') data.user = { nerve: db.user.nerve, at: now };
  if (step === 'hub' && db.crimesTypes) data.hubSeenAt = now;
  if (typeID && db.crimesByType) {
    const fresh = trimDB(db);
    const prev = data.state[typeID];
    // Forgery: materials are shared across projects as "open item % left + spare items", so the stock before and after
    // a step shows how much of an item that step used (e.g. Glue 40% + 64 spares → 35% + 64 = 0.05 of a Glue).
    if (typeID === 11 && step === 'attempt' && prev && prev.db) {
      const stock = cbt => { const m = {}; ((cbt && cbt.projects) || []).forEach(p => ((p.additionalInfo && p.additionalInfo.usableItems) || [])
        .forEach(u => { m[u.label] = (u.itemsAmount || 0) + (u.amount || 0) / 100; })); return m; };
      const before = stock(prev.db.crimesByType), after = stock(fresh.crimesByType);
      const used = data.used = data.used || {};
      const u = used[11] = used[11] || { items: {}, names: {}, nerve: 0, actions: 0 };
      u.names = u.names || {};
      for (const [label, b] of Object.entries(before)) {
        if (after[label] === undefined) continue;
        const d = b - after[label];
        if (d > 0 && d < 5) u.names[label] = (u.names[label] || 0) + d;
      }
      const lastSnap = data.last[11];
      const dN = db.currentUserStats && lastSnap ? db.currentUserStats.nerveUsed - lastSnap.nerve : 0;
      if (dN > 0 && dN <= 60) { u.nerve += dN; u.actions += 1; }
    }
    // Items used up by this action: compare item counts the crime page lists (e.g. Arson accelerants) before and after.
    if (step === 'attempt' && prev && prev.db && prev.db.crimesByType && Array.isArray(fresh.crimesByType && fresh.crimesByType.availableItems)) {
      const before = Object.fromEntries((prev.db.crimesByType.availableItems || []).map(i => [i.itemID, i.total]));
      const used = data.used = data.used || {};
      const u = used[typeID] = used[typeID] || { items: {}, nerve: 0, actions: 0 };
      for (const it of fresh.crimesByType.availableItems) {
        const d = (before[it.itemID] ?? it.total) - it.total;
        if (d > 0 && d < 50) u.items[it.itemID] = (u.items[it.itemID] || 0) + d;
      }
      const lastSnap = data.last[typeID];
      const dN = db.currentUserStats && lastSnap ? db.currentUserStats.nerveUsed - lastSnap.nerve : 0;
      if (dN > 0 && dN <= 60) { u.nerve += dN; u.actions += 1; }
    }
    // A crime result can carry less than the full page (e.g. no rig section after a crack attempt).
    // Merge it into what we already have instead of replacing it, so missing parts keep their last value.
    if (step !== 'crimesList' && prev && prev.db && isPlainObj(prev.db.crimesByType) && isPlainObj(fresh.crimesByType)) {
      fresh.crimesByType = { ...prev.db.crimesByType, ...fresh.crimesByType };
      for (const k of ['generalInfo', 'dirtyBomb', 'stats']) if (!fresh[k]) fresh[k] = prev.db[k];
    }
    data.state[typeID] = { seenAt: now, db: fresh };
    const rig = fresh.crimesByType && fresh.crimesByType.rig;
    if (rig && parseFloat(rig.bruteforcePower)) data.rigPower = parseFloat(rig.bruteforcePower);
  }
  if (typeID) saveRaw(typeID, step, json);
  if (typeID && db.currentUserStats) {
    recordSnapshot(data, typeID, db.currentUserStats, step === 'attempt' ? crimeID : null, now);
  }
  Store.save();
  return true;
}

function bodyText(body) {
  if (!body) return null;
  if (typeof body === 'string') return body;
  try {
    if (body instanceof URLSearchParams) return body.toString();
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      const o = {}; body.forEach((v, k) => { if (typeof v === 'string') o[k] = v; }); return JSON.stringify(o);
    }
  } catch { /* ignore */ }
  return null;
}

function installHooks(win, onChange) {
  Diag.hooked = true;
  console.log('[CrimeAdvisor] listening for crime data');
  const origFetch = win.fetch;
  win.fetch = async function (resource, config) {
    const res = await origFetch.apply(this, arguments);
    try {
      const url = typeof resource === 'string' ? resource : resource && resource.url;
      if (url && String(url).includes('sid=crimesData')) {
        let body = bodyText(config && config.body);
        const parse = b => res.clone().json().then(j => { if (handleResponse(url, b, j)) onChange(); })
          .catch(e => { Diag.seen += 1; Diag.lastError = 'could not parse: ' + e.message; });
        if (!body && resource && typeof resource !== 'string' && resource.clone) {
          resource.clone().text().then(t => parse(t)).catch(() => parse(null));
        } else parse(body);
      }
    } catch { /* never break the page */ }
    return res;
  };
  const P = win.XMLHttpRequest.prototype, open = P.open, send = P.send;
  P.open = function (m, url) { this._caUrl = url; return open.apply(this, arguments); };
  P.send = function (body) {
    if (this._caUrl && String(this._caUrl).includes('sid=crimesData')) {
      this.addEventListener('load', () => {
        try { if (handleResponse(String(this._caUrl), bodyText(body), JSON.parse(this.responseText))) onChange(); }
        catch (e) { Diag.lastError = 'XHR: ' + e.message; }
      });
    }
    return send.apply(this, arguments);
  };
}

// $/N for a crime. Recent play (last 14 days, else since install) is blended with lifetime:
// the more nerve spent recently, the more the recent figure counts (half-weight at 60N).
const RECENT_DAYS = 14;
function crimeRate(data, typeID, now = Date.now()) {
  const last = data.last[typeID];
  if (!last || last.money === null) return { rate: null, source: last ? 'pays items' : 'not seen' };
  const lifetime = last.nerve > 0 ? last.money / last.nerve : null;
  const today = Math.floor(now / 86400000);
  const daily = (data.daily && data.daily[typeID]) || [];
  const from = daily.find(d => d.day >= today - RECENT_DAYS && d.money !== null) || data.base[typeID];
  const dN = from ? last.nerve - from.nerve : 0;
  if (!from || dN <= 0) return { rate: lifetime, source: 'lifetime' };
  const recent = (last.money - from.money) / dN;
  const w = dN / (dN + MIN_RECENT_NERVE);
  const rate = lifetime === null ? recent : w * recent + (1 - w) * lifetime;
  return { rate, source: w >= 0.5 ? `recent, ${dN}N` : `mostly lifetime, ${dN}N recent`, recent, lifetime, recentNerve: dN };
}

// Learned $/attempt for one action, if we've seen enough of it.
function actionValue(data, typeID, crimeID, minN = 3) {
  const a = data.actions[`${typeID}:${crimeID}`];
  if (!a || a.n < minN) return null;
  return { perAttempt: a.money / a.n, perNerve: a.nerve ? a.money / a.nerve : null, n: a.n };
}

// ---------- react: backup reader for data the page already rendered ----------
// If the page fetched its crime data before this script was listening, the fetch hook sees nothing.
// React keeps that same data on the page's own elements, so we look for it there.
// Reads only the page you're viewing; sends nothing.

function reactKeyOf(el) {
  if (!el) return null;
  for (const k of Object.keys(el)) {
    if (k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$') || k.startsWith('__reactContainer$')) return k;
  }
  return null;
}

// Look for an object that holds `crimesByType` within a few levels of `obj`.
function findCrimeDB(obj, depth = 0, seen = new Set()) {
  if (!obj || typeof obj !== 'object' || depth > 5 || seen.has(obj)) return null;
  seen.add(obj);
  if (obj.crimesByType && (obj.currentUserStats || obj.currentLevel !== undefined || obj.crimesByType)) return obj;
  if (obj.DB && obj.DB.crimesByType) return obj.DB;
  // Redux store on a Provider
  if (typeof obj.getState === 'function' && typeof obj.dispatch === 'function') {
    try { const r = findCrimeDB(obj.getState(), depth + 1, seen); if (r) return r; } catch { /* ignore */ }
  }
  const keys = Array.isArray(obj) ? [] : Object.keys(obj);
  for (const k of keys) {
    if (k === 'children' || k === '_owner' || k.startsWith('__react') || k === 'return' || k === 'sibling' || k === 'alternate') continue;
    let v; try { v = obj[k]; } catch { continue; }
    if (v && typeof v === 'object') { const r = findCrimeDB(v, depth + 1, seen); if (r) return r; }
  }
  return null;
}

// Walk up from a crime row (or the app root) through React's tree, checking props and state.
function readRenderedCrimeDB(doc = document) {
  const starts = [
    doc.querySelector('[class*="crimeOptionSection__"]'),
    doc.querySelector('.crimes-app'),
    doc.querySelector('[class*="virtualList__"]'),
    doc.getElementById('react-root'),
  ].filter(Boolean);
  for (const start of starts) {
    const key = reactKeyOf(start);
    if (!key) continue;
    let fiber = start[key];
    if (fiber && fiber.current) fiber = fiber.current;          // container root
    for (let i = 0; fiber && i < 60; i++, fiber = fiber.return) {
      const found = findCrimeDB(fiber.memoizedProps) || findCrimeDB(fiber.memoizedState);
      if (found) return found;
    }
  }
  return null;
}

// Called from the UI loop on crime pages. Once per crime per page load.
const ReactBackup = {
  done: {},
  tryRead(typeID, onChange) {
    if (!typeID || this.done[typeID]) return;
    const data = Store.load();
    const st = data.state[typeID];
    if (st && st.seenAt >= Diag.pageLoadedAt) { this.done[typeID] = true; return; } // fetch hook already got it
    let db = null;
    try { db = readRenderedCrimeDB(); } catch (e) { Diag.lastError = 'page read: ' + e.message; }
    if (!db) return;
    this.done[typeID] = true;
    Diag.fromPage += 1;
    handleResponse('/page.php?sid=crimesData&step=crimesList', JSON.stringify({ typeID: String(typeID) }), { DB: db });
    onChange();
  },
};

// ---------- crimes: one analyzer per crime ----------
// Each returns { actionable, note, options: [{ label, detail, best }] }.
// Cross-crime ranking uses measured $/N (crimeRate); analyzers pick the best option inside a crime.


// Emforus: dead-body jobs are the top Disposal earners. Used only to order jobs until your own log has values.
const DISPOSAL_PRIORITY = ['Dead Body', 'Body Part', 'Murder Weapon', 'Firearm', 'Vehicle'];
// Emforus Crimes 2.0 guide (Jan 2025): Dead Body ~18k/N abandoned, ~12.5k/N buried; dead bodies show up about every 3 days.
const DISPOSAL_PRIOR = { 'Dead Body': { Abandon: 18000, Bury: 12500 } };

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


// Scamming targets (fields confirmed from a real export): `cooldown` = when a hesitation ends (epoch seconds),
// `barPosition` = the tile you're on ('neutral', 'hesitation', 'concern', 'temptation', 'low'/'medium'/'high', 'fail'),
// `bar` = the 50 tiles, `pip` = your index on it, `actionMin`/`actionMax` = how far each reply moves you.
function scamWaitSeconds(t) { return t && t.cooldown ? Math.max(0, t.cooldown - Date.now() / 1000) : 0; }
function scamTargetWaiting(t) { return scamWaitSeconds(t) > 0; }
function scamTargetConcern(t) { return !scamTargetWaiting(t) && t.barPosition === 'concern'; }

// Safest next reply: score where each reply could land, uniformly across its range.
const TILE_SCORE = { high: 3, medium: 2, low: 1.2, temptation: 0.6, neutral: 0.4, sensitivity: 0, hesitation: -0.6, concern: -1, fail: -4 };
function scamBestReply(t) {
  if (!t || !Array.isArray(t.bar) || typeof t.pip !== 'number' || !t.actionMin) return null;
  let best = null;
  for (const [act, min] of Object.entries(t.actionMin)) {
    const max = (t.actionMax && t.actionMax[act]) ?? min;
    if (!max && !min) continue;                       // accelerator has no move of its own
    const dir = act === 'backward' ? -1 : 1;
    let score = 0, n = 0, reward = 0;
    for (let d = min; d <= max; d++) {
      const tile = t.bar[Math.max(0, Math.min(t.bar.length - 1, t.pip + dir * d))] || 'neutral';
      score += TILE_SCORE[tile] ?? 0; n++; if (/^(low|medium|high)$/.test(tile)) reward++;
    }
    const cand = { act, name: (t.actionsNames && t.actionsNames[act]) || act, score: score / n, reward: reward / n, from: t.pip + dir * min, to: t.pip + dir * max };
    if (!best || cand.score > best.score) best = cand;
  }
  return best;
}

// Material cost per Forgery project when you haven't set your own (crimeAdvisorSet('materials', 'Passport', 90000)).
// Passport: implied by a player's reported ~$8k/N net on $580k sales at ~61N (≈ $90k). Others: unknown until you set them.
const FORGERY_MATERIAL_DEFAULT = { Passport: 90000 };
const lastProjectName = c => { const p = (c.projects || [])[0]; return p ? p.projectTitle : 'Passport'; };


// Value of items a crime has used up (tracked from item counts before/after each action), per nerve, at current prices.
function itemCostPerNerve(data, typeID) {
  const u = data && data.used && data.used[typeID];
  if (!u || u.nerve < 20 || !Prices.ready()) return null;
  let value = 0;
  for (const [id, n] of Object.entries(u.items || {})) value += (Prices.of(Number(id)) || 0) * n;
  for (const [name, n] of Object.entries(u.names || {})) value += (Prices.of(name) || 0) * n;
  return { perN: value / u.nerve, value, nerve: u.nerve, actions: u.actions };
}

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
      const known = DISPOSAL_PRIOR[job.title];
      if (known) methods.forEach(x => { if (!x.learned && known[x.m.title]) x.score = known[x.m.title] * x.sr.p; });
      methods.sort((a, b) => (b.learned ? 1 : 0) - (a.learned ? 1 : 0) || b.score - a.score);
      const best = methods[0];
      const pr = DISPOSAL_PRIORITY.indexOf(job.title);
      const prior = (DISPOSAL_PRIOR[job.title] && DISPOSAL_PRIOR[job.title][best.m.title]) ?? ctx.rate;
      const b = blend(prior, best.learned);
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
      // Cyclists are worth far more than their cash: Emforus puts them at ~10k/N because ~1 in 15 drops Xanax.
      const xan = Prices.of('Xanax');
      const prior = /cyclist/i.test(m.title)
        ? (xan ? ((range ? mid(range) : 0) * sr.p + xan / 15) / (m.nerve || 5) : 10000)   // ~1 in 15 cyclists drops Xanax (Emforus)
        : (range ? mid(range) * sr.p / (m.nerve || 5) : null);
      const b = blend(prior, actionValue(data, 5, m.crimeID));
      const status = m.crimeInfo && m.crimeInfo.status ? m.crimeInfo.status.title : '';
      const learnedPP = actionValue(data, 5, m.crimeID);
      return { key: m.title, perN: b.perN, nerve: m.nerve || 5, units: 0, src: b.src, noPick: !learnedPP,
        short: b.perN !== null ? `${fmt.perN(b.perN)} · ${Math.round(sr.p * 100)}%` : `${Math.round(sr.p * 100)}%`,
        label: m.title, detail: `${status} · ${range ? `${fmt.money(range[0])}–${fmt.money(range[1])}` : 'cash unknown'} · ${b.src}`,
        sort: b.perN || 0 };
    }).sort((a, b) => b.sort - a.sort);
    if (opts.length && opts[0].perN) opts[0].best = true;
    return { actionable: true, note: 'Hunt cyclists (~10k/N from Xanax drops); most other marks pay under 2k/N', options: opts };
  },

  6(db) { // Card Skimming: install (busy spots) → let cards build → recover (4N) → sell in big batches (6N)
    const st = db.stats || {};
    const c = db.crimesByType || {};
    const subs = c.subCrimes || [];
    const perCard = st.cardDetailsSold ? (st.moneyMadeTotal || st.moneyFoundTotal) / st.cardDetailsSold : 215;
    const avgHaul = st.skimmersRecovered ? st.cardDetailsRecovered / st.skimmersRecovered : 40;
    const lossRate = st.skimmersInstalled ? (st.skimmersLost || 0) / st.skimmersInstalled : 0.3;
    const ripe = subs.filter(s => s.crimeInfo && s.crimeInfo.cards >= avgHaul);
    const held = (c.sellCards && c.sellCards.additionalInfo && c.sellCards.additionalInfo.collectedCards) || 0;
    const SELL_BATCH = 500; // Emforus: sell at least 500–1,000 details at once; bigger sales pay more per detail (wiki)
    const where = [...new Set(subs.map(s => s.title))];
    const slow = where.length && where.every(t => /gas station/i.test(t));
    const steps = [];
    if (held >= SELL_BATCH) steps.push({ action: `Sell your ${held} card details (6N)`, perN: held * perCard / 6, nerve: 6, units: 1, why: `~${fmt.money(perCard)} each; big batches pay more per detail` });
    if (ripe.length) steps.push({ action: `Recover ${ripe.length} skimmer${ripe.length > 1 ? 's' : ''} with ${Math.round(avgHaul)}+ cards (4N each)`, perN: avgHaul * perCard / 4, nerve: 4, units: ripe.length,
      why: 'they hold your usual haul; waiting longer risks losing them' });
    const installRate = avgHaul * perCard * (1 - lossRate) / (6 + 4);
    const tips = [];
    if (held > 0 && held < SELL_BATCH) tips.push(`holding ${held} details: sell at ${SELL_BATCH}+`);
    if (slow) tips.push('all at Gas Station (safest but slowest): put new ones at Bus Station or Post Office');
    tips.push('recover before going offline for days');
    const most = subs.reduce((mx, s2) => Math.max(mx, (s2.crimeInfo && s2.crimeInfo.cards) || 0), 0);
    const next = steps[0];
    return {
      actionable: !!next,
      note: next ? `Next: ${next.action} — ${next.why} · ${tips.join(' · ')}`
        : `Let them build: ${subs.length} skimmers, fullest has ${Math.round(most)} cards (you usually recover at ~${Math.round(avgHaul)}) · ${tips.join(' · ')}`,
      steps, stepRate: next ? next.perN : null, options: [],
      installRate,
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
    return { actionable: props.length > 0, note: `Next: ${next} · ${props.length} targets${soon ? `, ${soon} expiring soon` : ''} · burgle at 40–60% confidence; industrial pays best; item drops aren't counted here`, options: opts };
  },

  8(db) { // Hustling: gather an audience → (shill / pickpocket work that audience) → collect. Games lose money for you.
    const c = db.crimesByType || {};
    const st = db.stats || {};
    const sh = (c.shill && c.shill.additionalInfo && c.shill.additionalInfo.moneyToCollect) || 0;
    const pp = (c.pickpocket && c.pickpocket.additionalInfo && c.pickpocket.additionalInfo.moneyToCollect) || 0;
    const aud = (c.audience && c.audience.additionalInfo) || {};
    const crowd = (aud.currentAudience || []).length;
    const steps = [];
    // Money already earned can be collected; never suggest recruiting or relying on accomplices without a crowd.
    if (sh) steps.push({ action: `Collect ${fmt.money(sh)} from your shill (2N)`, perN: sh / 2, nerve: 2, units: 1 });
    if (pp) steps.push({ action: `Collect ${fmt.money(pp)} from your pickpocket (2N)`, perN: pp / 2, nerve: 2, units: 1 });
    const net = (st.totalMoneyWon || 0) - (st.totalMoneyLost || 0);
    const accompliceTotal = (st.shillMoneyCollected || 0) + (st.pickpocketMoneyCollected || 0);
    const why = crowd ? `${crowd} in your audience` : 'no audience, so your shill and pickpocket aren’t earning';
    return {
      actionable: steps.length > 0,
      note: steps.length ? `Next: ${steps[0].action}` :
        `Low earner: ${why}. Emforus puts maxed Hustling at ~3k/N; your games are ${fmt.money(net)} lifetime (includes leveling)` + (accompliceTotal ? ` · accomplices have brought in ${fmt.money(accompliceTotal)}` : ''),
      steps, stepRate: steps.length ? steps[0].perN : null, options: [],
    };
  },
  11(db, data) { // Forgery: start projects → advance each step (5N, retry on fail) → sell at the Print Store
    const c = db.crimesByType || {};
    const st = db.stats || {};
    const settings = (data && data.settings) || {};
    const ids = st.crimesByIDAttempts || {}, succ = st.crimesByIDAttemptsSucc || {};
    // A failed step is retried, so each step costs 5N ÷ your success rate on that step (not one long all-or-nothing chain).
    // Steps have few tries each, so use the project's pooled success rate (e.g. Passport 174/178) for every step.
    const pooled = bp => { let a = 0, s2 = 0; for (let i = 1; i <= (bp.steps || []).length; i++) { a += ids[bp.crimeID + i] || 0; s2 += succ[bp.crimeID + i] || 0; } return (s2 + 1) / (a + 2); };
    const opts = (c.beginProject || []).filter(bp => bp.available !== false).map(bp => {
      const name = String(bp.title).replace(/^Begin /, '').replace(/ project$/, '');
      const price = REF.forgery[name.toLowerCase()];
      const steps = (bp.steps || []).length || 4;
      const nerve = steps * 5 / pooled(bp);
      const setCost = settings.materials && settings.materials[name];
      const priced = materialCostFromPrices(name);
      const priceCost = priced && !priced.missing.length ? priced.total : undefined;
      const defCost = FORGERY_MATERIAL_DEFAULT[name];
      const measured = name === lastProjectName(c) ? itemCostPerNerve(data, 11) : null;   // per nerve, from your own steps
      const measuredCost = measured ? measured.perN * nerve : undefined;
      const cost = setCost ?? measuredCost ?? priceCost ?? defCost ?? null;
      const market = Prices.of(name);
      const sale = Math.max(price || 0, market || 0) || null;
      const gross = sale ? sale / nerve : null;
      const perN = sale && cost !== null ? (sale - cost) / nerve : gross;
      const costTxt = setCost !== undefined ? `materials ${fmt.money(setCost)} (yours)`
        : measuredCost !== undefined ? `materials ~${fmt.money(measuredCost)} (measured over ${measured.nerve}N of your steps)`
        : priceCost !== undefined ? `materials ~${fmt.money(priceCost)} (market prices, 1 of each)`
        : defCost !== undefined ? `materials ~${fmt.money(defCost)} (assumed${priced && priced.missing.length ? `; no price for ${priced.missing.join(', ')}` : ''})` : 'materials not set';
      const sellTip = market && price && market > price * 1.03 ? ` · sells for ${fmt.money(market)} on the item market (Print Store pays ${fmt.money(price)})` : '';
      return {
        key: name, perN, nerve: Math.round(nerve), units: Infinity, gross,
        src: cost !== null ? 'after materials' : 'before materials', noPick: cost === null,
        short: perN ? `${fmt.perN(perN)} · ${Math.round(nerve)}N` : 'price unknown',
        label: name,
        detail: `${steps} steps · ~${Math.round(nerve)}N with your step success · ${price ? fmt.money(price) + ' at the Print Store' : 'price unknown'} · ${costTxt}${sellTip}`,
        sort: perN || 0,
      };
    }).sort((a, b) => b.sort - a.sort);
    if (opts.length && opts[0].perN) opts[0].best = true;
    const best = opts.find(o => !o.noPick && o.perN) || opts[0];

    // Projects already running: finish the ones closest to done; skip drying or blocked ones.
    const projects = c.projects || [];
    const blockedReason = p => p.unavailableReason && !/nerve/i.test(p.unavailableReason) ? p.unavailableReason.replace(/^You don't have the required item: /, 'need ') : null;
    const drying = p => p.additionalInfo && p.additionalInfo.cooldownStatus;
    const ready = projects.filter(p => !blockedReason(p) && !drying(p)).sort((a, b) => (b.additionalInfo.step || 0) - (a.additionalInfo.step || 0));
    const blocked = projects.filter(blockedReason);
    const dryingN = projects.filter(p => !blockedReason(p) && drying(p)).length;
    const outOf = [];
    const seen = new Set();
    projects.forEach(p => ((p.additionalInfo && p.additionalInfo.usableItems) || []).forEach(u => {
      if (seen.has(u.label)) return; seen.add(u.label);
      if (!u.itemsAmount) outOf.push(`${u.label} (${u.amount}% of the last one left)`);
    }));
    const byStep = {};
    ready.forEach(p => { const k = `${p.title} (step ${p.additionalInfo.step})`; byStep[k] = (byStep[k] || 0) + 1; });
    const stepList = Object.entries(byStep).slice(0, 3).map(([k, n]) => `${n}× ${k}`).join(', ');
    const steps = [];
    if (ready.length) steps.push({ action: `Advance ${ready.length} project${ready.length > 1 ? 's' : ''}, furthest along first: ${stepList}`,
      perN: best ? best.perN : null, nerve: 5, units: ready.length, why: 'each step brings a Passport closer to its sale' });
    if (best && best.perN) steps.push({ action: `Start new ${best.label} projects`, perN: best.perN, nerve: best.nerve, units: Infinity, deferred: true, why: best.detail.split(' · ').pop() });
    const warn = [
      blocked.length ? `${blocked.length} blocked: ${[...new Set(blocked.map(blockedReason))].join(', ')}` : null,
      dryingN ? `${dryingN} drying` : null,
      outOf.length ? `buy more: ${outOf.join(', ')}` : null,
      c.totalPrinters ? `${c.totalPrinters - (c.totalPrintersInUse || 0)} of ${c.totalPrinters} printers free` : null,
    ].filter(Boolean).join(' · ');
    const next = steps[0];
    return {
      actionable: !!next,
      note: next ? `Next: ${next.action}${warn ? ' · ' + warn : ''}` : (warn || 'No projects available'),
      steps, stepRate: next ? next.perN : null, options: opts,
    };
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
    const tip = replyable.length ? scamBestReply(replyable[0]) : null;
    const tipTxt = tip ? ` · safest reply for ${replyable[0].name || 'the first'} (${replyable[0].scamMethod || 'scam'}): ${tip.name}${tip.reward ? `, ${Math.round(tip.reward * 100)}% chance to land in a reward zone` : ''}` : '';
    if (replyable.length) steps.push({ action: `Reply to ${replyable.length} target${replyable.length > 1 ? 's' : ''} (3N per reply)${tipTxt}`, perN: workRate, nerve: 3, units: Math.round(replyable.length * nervePerTarget / 3), why: `you average ${fmt.money(perTarget)} per target for ~${Math.round(nervePerTarget)}N` });
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
  13(db, data) { // Arson: collect → light every hands-off job and let it burn → then work the jobs that need watching
    const c = db.crimesByType || {};
    const st = db.stats || {};
    const jobs = c.targets || [];
    const have = Object.fromEntries((c.availableItems || []).map(i => [i.itemID, i.total]));
    const perJob = st.rewardsCollected ? st.moneyFoundTotal / st.rewardsCollected : null;
    const nervePerJob = st.rewardsCollected ? st.nerveUsed / st.rewardsCollected : 23;
    const itemCost = itemCostPerNerve(data, 13);
    const rate = perJob ? perJob / nervePerJob - (itemCost ? itemCost.perN : 0) : null;
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
      why: `${rule(handsOff[0])}, so it can burn out on its own; start these first so they burn while you do the rest` +
        (itemCost ? ` · accelerants cost you ~${fmt.perN(itemCost.perN)} (tracked over ${itemCost.nerve}N)` : '') });
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
  // Explain a change of top pick, so a switch never looks random.
  if (top) {
    const prev = data.lastTop;
    if (prev && prev.typeID !== top.typeID) {
      const was = rows.find(r => r.typeID === prev.typeID);
      top.switchedFrom = was ? `${was.name} is now ${was.actionable ? fmt.perN(was.rate) : 'done for now'}${was.note ? ` (${was.note.replace(/^Next: /, '').slice(0, 60)})` : ''}` : null;
    }
    if (!prev || prev.typeID !== top.typeID) data.lastTop = { typeID: top.typeID, at: Date.now(), was: prev ? prev.typeID : null };
    else if (prev.was) {
      const was = rows.find(r => r.typeID === prev.was);
      if (was && Date.now() - prev.at < 30 * 60000) top.switchedFrom = `${was.name} is now ${was.actionable ? fmt.perN(was.rate) : 'done for now'}`;
    }
  }
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

// ---------- plan: what to spend the nerve you have on ----------

// Nerve per repeat for crimes ranked by your overall rate (no per-option numbers).
const UNIT_NERVE = { 1: 2, 2: 5, 3: 3, 4: 4, 6: 6, 8: 2, 12: 8, 13: 20 };
const NERVE_REGEN_MIN = 5; // 1 nerve every 5 minutes

// Read "14/130" from the sidebar's nerve bar; falls back to the last nerve the crime data reported.
function readNerve(doc = document) {
  const candidates = [];
  const bar = doc.getElementById('barNerve');
  if (bar) candidates.push(bar);
  doc.querySelectorAll('[class*="bar-name"]').forEach(n => { if (/nerve/i.test(n.textContent)) candidates.push(n.parentNode); });
  for (const c of candidates) {
    const v = c && (c.querySelector('[class*="bar-value"]') || c);
    const m = v && v.textContent.match(/(\d+)\s*\/\s*(\d+)/);
    if (m) return { cur: Number(m[1]), max: Number(m[2]), from: 'sidebar' };
  }
  const u = Store.load().user;
  return u ? { cur: u.nerve, max: null, from: 'crime data' } : null;
}

// Greedy: best $/N first, within what you can afford right now.
function planNerve(rows, nerve) {
  if (!nerve || nerve.cur <= 0) return { steps: [], left: nerve ? nerve.cur : 0 };
  const cands = [];
  rows.filter(r => r.actionable && !r.newDay && !r.noPick).forEach(r => {
    if (r.steps) {
      // Multi-step crimes: only the steps that can be done now, each as many times as it really can be.
      r.steps.filter(st => !st.wait && st.perN > 0 && st.nerve).forEach(st =>
        cands.push({ crime: r.name, label: st.action.replace(/ \(.*$/, ''), perN: st.perN, nerve: st.nerve, units: st.units || 1 }));
      return;
    }
    const opts = (r.options || []).filter(o => o.perN > 0 && o.units !== 0 && o.nerve && !o.noPick);
    if (opts.length) opts.forEach(o => cands.push({ crime: r.name, label: o.key || o.label, perN: o.perN, nerve: o.nerve, units: o.units }));
    else if (r.crimeRate > 0 && UNIT_NERVE[r.typeID]) cands.push({ crime: r.name, label: null, perN: r.crimeRate, nerve: UNIT_NERVE[r.typeID], units: Infinity });
  });
  // Crimes with new jobs since midnight: worth a look first, size unknown.
  const look = rows.filter(r => r.newDay).map(r => r.name);
  cands.sort((a, b) => b.perN - a.perN);
  // Don't pad the plan with crimes worth under a quarter of the best one.
  const floor = cands.length ? Math.min(cands[0].perN / 4, 2000) : 0;
  for (let i = cands.length - 1; i >= 0; i--) if (cands[i].perN < floor) cands.splice(i, 1);
  let left = nerve.cur;
  const steps = [];
  for (const c of cands) {
    if (left < c.nerve) continue;
    const n = Math.min(c.units, Math.floor(left / c.nerve));
    if (n <= 0) continue;
    steps.push({ ...c, count: n });
    left -= n * c.nerve;
    if (left < 2) break;
  }
  return { steps, left, look };
}

function capWarning(nerve) {
  if (!nerve || !nerve.max) return null;
  const missing = nerve.max - nerve.cur;
  if (missing <= 0) return 'Nerve is full: regen is going to waste';
  const min = missing * NERVE_REGEN_MIN;
  return min <= 60 ? `Nerve full in ~${min} min` : null;
}

// With too little nerve for anything worth doing, say so plainly and when that changes.
function outOfNerve(nerve, plan) {
  if (!nerve || plan.steps.length) return null;
  const need = 5 - nerve.cur;
  if (need <= 0) return null;
  const at = new Date(Date.now() + need * NERVE_REGEN_MIN * 60000);
  return `Out of nerve (${nerve.cur}N): you'll have 5N around ${at.toISOString().slice(11, 16)} TCT`;
}

function planText(plan, nerve) {
  if (!nerve) return '';
  const out = outOfNerve(nerve, plan);
  if (out) return out;
  const parts = plan.steps.slice(0, 4).map(s =>
    `${s.crime}${s.label ? ': ' + s.label : ''}${s.count > 1 ? ' ×' + s.count : ''} (${s.count * s.nerve}N, ${fmt.perN(s.perN)})`);
  let t = `With ${nerve.cur}N: ` + (parts.length ? parts.join(' → ') : 'nothing worth it yet');
  if (plan.look && plan.look.length) t = `Open ${plan.look.join(', ')} first (new since 00:00 TCT) · ` + t;
  return t;
}

// ---------- ui: small labels on Torn's own page, like Crime Profitability ----------
// Hub: a $/N badge on every crime card, ★ on the best one.
// Crime pages: ★ + reason on the best option, plus one line under the page header.
// Built with textContent only; re-applied every second because React re-renders rows.

const CSS = `
.ca-host{position:relative !important}
.ca-badge{position:absolute;z-index:5;pointer-events:none;padding:0 5px;border-radius:8px;font:bold 10px/15px Arial,sans-serif;
  background:rgba(20,20,20,.78);color:#fff;white-space:nowrap;max-width:60%;overflow:hidden;text-overflow:ellipsis}
.ca-badge.ca-good{background:#3c8d4f}
.ca-badge.ca-bad{background:#a94442}
.ca-badge.ca-tl{top:3px;left:3px}
.ca-badge.ca-tr{top:3px;right:3px}
.ca-pick{outline:2px solid #3c8d4f !important;outline-offset:-2px}
.ca-line{display:flex;justify-content:space-between;gap:10px;padding:5px 10px;margin:6px 0;font-size:12px;border-left:3px solid #3c8d4f;background:rgba(60,141,79,.12);border-radius:3px}
.ca-ctl{white-space:nowrap;opacity:.85}
.ca-btn{background:none;border:0;padding:0;font:inherit;color:inherit;text-decoration:underline;cursor:pointer}
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

// One floating tag per host, positioned over a corner so Torn's layout never shifts.
// `corner` is 'tl' or 'tr'. Updated in place instead of re-added.
function badge(host, key, text, cls, corner = 'tl') {
  if (!host) return;
  let b = Array.from(host.children).find(c => c.classList && c.classList.contains('ca-badge') && c.dataset.ca === key);
  if (!text) { if (b) b.remove(); return; }
  if (!host.classList.contains('ca-host')) host.classList.add('ca-host');
  if (!b) { b = h('span', 'ca-badge'); b.dataset.ca = key; host.appendChild(b); }
  const c = `ca-badge ca-${corner}` + (cls ? ' ' + cls : '');
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

function headerLine(text) {
  const header = document.querySelector('.crimes-app-header') || document.querySelector('.content-title');
  if (!header || !header.parentNode) return;
  let line = document.getElementById('ca-line');
  if (!line) {
    line = h('div', 'ca-line'); line.id = 'ca-line';
    const msg = h('span'); msg.id = 'ca-msg'; line.appendChild(msg);
    const ctl = h('span', 'ca-ctl');
    const key = h('button', 'ca-btn', Prices.key() ? 'API key ✓' : 'Add API key'); key.type = 'button'; key.id = 'ca-key';
    key.addEventListener('click', e => {
      e.preventDefault();
      const k = prompt('Torn API key for item prices (Public access is enough). Stored in this browser only; sent only to api.torn.com. Leave empty to remove.', Prices.key());
      if (k === null) return;
      Prices.setKey(k);
      key.textContent = Prices.key() ? 'API key ✓' : 'Add API key';
      Prices.refresh(pageFetch).then(() => UI.render());
    });
    const exp = h('button', 'ca-btn', 'Export data'); exp.type = 'button'; exp.id = 'ca-export';
    exp.addEventListener('click', e => { e.preventDefault(); exportRaw(); });
    ctl.appendChild(key); ctl.appendChild(document.createTextNode(' · ')); ctl.appendChild(exp);
    line.appendChild(ctl);
  }
  if (line.previousElementSibling !== header) header.parentNode.insertBefore(line, header.nextSibling);
  const msg = document.getElementById('ca-msg');
  const full = text + (Prices.error ? ` · prices: ${Prices.error}` : '');
  if (msg.textContent !== full) msg.textContent = full;
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
      const here = currentCrime();
      if (here) ReactBackup.tryRead(here, () => {});
      const data = Store.load();
      const ranking = rankAll(data);
      if (here) this.crimePage(here, ranking); else this.hub(ranking);
      Store.save();
    } catch (e) { console.warn('[CrimeAdvisor]', e); }
  },

  // ---- Crime Hub: one badge per card ----
  hub({ top, rows }) {
    const nerve = readNerve();
    const plan = planNerve(rows, nerve);
    const head = top ? `★ Best now: ${top.name} ${fmt.perN(top.rate)} (${top.source})${top.switchedFrom ? ` · switched: ${top.switchedFrom}` : ''}` : 'Open the crimes you play once so the Advisor can read them';
    headerLine([head, planText(plan, nerve), capWarning(nerve)].filter(Boolean).join(' · '));
    document.querySelectorAll('.crimes-hub-root a, .crimes-hub-crime').forEach(card => {
      const titleEl = card.querySelector('[class*="crimeTitle__"]');
      if (!titleEl) return;
      const r = rows.find(x => norm(x.name) === norm(titleEl.textContent));
      if (!r) return;
      const isTop = !!top && r.typeID === top.typeID;
      const txt = r.rate !== null ? `${isTop ? '★ ' : ''}${fmt.perN(r.rate)}` : null;
      badge(card, 'rate', txt, isTop ? 'ca-good' : (r.rate !== null && r.rate < 0 ? 'ca-bad' : ''), 'tr');
      const status = r.newDay ? `new ${DAILY[r.typeID]}` : r.stale ? `checked ${fmt.ago(r.seenAt)}` : (!r.seenAt ? 'open once' : null);
      badge(card, 'status', status, r.newDay ? 'ca-good' : '', 'tl');
      card.classList.toggle('ca-pick', isTop);
    });
  },

  // ---- Crime pages ----
  crimePage(typeID, { top, rows }) {
    const r = rows.find(x => x.typeID === typeID);
    if (!r) return;

    // One line under the header: your $/N here, the best crime now, and this crime's status.
    {
      const parts = [`${r.name}: ${fmt.perN(r.rate)} (${r.source})`];
      if (top && top.typeID !== typeID) parts.push(`Best now: ${top.name} ${fmt.perN(top.rate)}${top.switchedFrom && top.switchedFrom.startsWith(r.name) ? ` (${r.name} dropped below it)` : ''}`);
      else if (top) parts.push('★ Best crime right now');
      const nv = readNerve();
      const cap = capWarning(nv);
      if (cap) parts.push(cap);
      if (nv && nv.cur < 2) parts.unshift(`Out of nerve (${nv.cur}N)`);
      let text = parts.join(' · ') + (r.note ? ` — ${r.note}` : '');
      if (!r.seenAt) {
        text = `Crime Advisor ${Diag.hooked ? 'is listening' : 'is NOT listening'} · crime data read this page load: ${Diag.read}` +
          (Diag.lastError ? ` · last error: ${Diag.lastError}` : '') + ' — press F5 so Torn reloads the crime data.';
      }
      headerLine(text);
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
      badge(row, 'opt', (o.best ? '★ ' : '') + o.short, o.best ? 'ca-good' : '');
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
      badge(row, 'opt', o ? (o.best ? '★ ' : '') + o.short : null, o && o.best ? 'ca-good' : '');
    });
  },

  // Cracking: match rows by service name.
  cracking(optRows, r) {
    optRows.forEach(row => {
      const svc = row.querySelector('[class*="service__"]');
      const o = svc && r.options.find(x => norm(x.service) === norm(svc.textContent));
      badge(row, 'opt', o ? (o.best ? '★ ' : '') + o.short : null, o && o.best ? 'ca-good' : '');
    });
  },
};

// ---------- main ----------
const pageWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
const pageFetch = (...a) => pageWin.fetch(...a);
installHooks(pageWin, () => UI.render());
try { pageWin.crimeAdvisorExport = exportRaw; pageWin.crimeAdvisorSet = setSetting; } catch { /* ignore */ }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => UI.mount());
else UI.mount();
// Item prices: once on load, then whenever the 6-hour cache runs out.
Prices.refresh(pageFetch).then(ok => { if (ok) UI.render(); });
setInterval(() => Prices.refresh(pageFetch).then(ok => { if (ok) UI.render(); }), 15 * 60 * 1000);

})();
