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
.ca-line{padding:5px 10px;margin:6px 0;font-size:12px;border-left:3px solid #3c8d4f;background:rgba(60,141,79,.12);border-radius:3px}
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
    const header = document.querySelector('.crimes-app-header') || document.querySelector('.content-title');
    if (header && header.parentNode) {
      let line = document.getElementById('ca-line');
      if (!line) { line = h('div', 'ca-line'); line.id = 'ca-line'; }
      if (line.previousElementSibling !== header) header.parentNode.insertBefore(line, header.nextSibling);
      const parts = [`Your ${r.name}: ${fmt.perN(r.rate)} (${r.source})`];
      if (top && top.typeID !== typeID) parts.push(`Best now: ${top.name} ${fmt.perN(top.rate)}`);
      else if (top) parts.push('★ Best crime right now');
      let text = parts.join(' · ') + (r.note ? ` — ${r.note}` : '');
      if (!r.seenAt) {
        text = `Crime Advisor ${Diag.hooked ? 'is listening' : 'is NOT listening'} · crime data seen this page load: ${Diag.read}` +
          (Diag.lastError ? ` · last error: ${Diag.lastError}` : '') +
          ' — press F5 on this page so Torn reloads the crime data.';
      }
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
