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

const Diag = { hooked: false, seen: 0, read: 0, lastStep: '', lastError: '' };

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
  if (typeID && db.crimesByType) data.state[typeID] = { seenAt: now, db: trimDB(db) };
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
