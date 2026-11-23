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
