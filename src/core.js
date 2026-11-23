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
