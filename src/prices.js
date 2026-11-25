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
    localStorage.removeItem(KEY_STORE + '.blocked'); this.blocked = 0;
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
    if (localStorage.getItem(KEY_STORE + '.blocked')) { this.error = 'key not working; click "API key" to replace it'; return false; }
    this.loading = true;
    try {
      const res = await fetchFn(`https://api.torn.com/torn/?selections=items&key=${encodeURIComponent(key)}&comment=CrimeAdvisor`);
      const j = await res.json();
      if (j.error) {
        // Torn asks tools to stop using keys that are invalid, paused or too limited, rather than retrying them.
        if ([2, 10, 13, 16, 18].includes(j.error.code)) { this.blocked = j.error.code; localStorage.setItem(KEY_STORE + '.blocked', String(j.error.code)); }
        throw new Error(`API error ${j.error.code}: ${j.error.error}${this.blocked ? ' (key paused here: click "API key" to fix it)' : ''}`);
      }
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
