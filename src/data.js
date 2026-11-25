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
