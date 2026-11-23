// ---------- ui: one floating panel, built with textContent only ----------

const CSS = `
#ca-panel{position:fixed;right:12px;bottom:12px;width:350px;max-height:70vh;overflow:auto;z-index:99999;
  background:#1d1f21;color:#e6e6e6;font:12px/1.4 Arial,sans-serif;border:1px solid #444;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.4)}
#ca-panel.ca-min{width:auto;max-height:none;overflow:visible}
#ca-panel.ca-inline{position:relative;right:auto;bottom:auto;width:auto;max-height:none;margin:0 0 10px;box-shadow:none}
#ca-panel.ca-inline .ca-body{display:grid;grid-template-columns:1fr 1fr;gap:0 16px}
#ca-panel.ca-inline .ca-col{min-width:0}
@media (max-width:784px){#ca-panel.ca-inline .ca-body{grid-template-columns:1fr}}
#ca-panel.ca-float{left:12px;right:auto}
#ca-panel .ca-head{display:flex;justify-content:space-between;align-items:center;padding:6px 10px;background:#2a2d30;
  border-radius:8px 8px 0 0;cursor:pointer;position:sticky;top:0}
#ca-panel .ca-title{font-weight:bold}
#ca-panel .ca-sub{color:#9aa0a6;font-size:11px}
#ca-panel .ca-body{padding:8px 10px}
#ca-panel.ca-min .ca-body{display:none}
#ca-panel .ca-top{border:1px solid #3c8d4f;background:rgba(60,141,79,.15);border-radius:6px;padding:6px 8px;margin-bottom:8px}
#ca-panel .ca-top b{font-size:13px}
#ca-panel h4{margin:8px 0 4px;font-size:11px;text-transform:uppercase;color:#9aa0a6;letter-spacing:.04em}
#ca-panel .ca-row{padding:4px 0;border-top:1px solid #2f3235}
#ca-panel .ca-row:first-of-type{border-top:0}
#ca-panel .ca-line{display:flex;justify-content:space-between;gap:8px}
#ca-panel .ca-best{color:#7fd08f}
#ca-panel .ca-dim{color:#9aa0a6}
#ca-panel .ca-neg{color:#e07a7a}
#ca-panel button{background:#2f3235;color:#ccc;border:1px solid #555;border-radius:4px;font-size:11px;padding:2px 6px;cursor:pointer}
`;

function h(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined && text !== null) el.textContent = text;
  return el;
}

function currentCrime() {
  const m = (location.hash || '').match(/#\/([a-z]+)/i);
  return m ? ROUTES[m[1].toLowerCase()] || null : null;
}

const UI = {
  el: null,
  minimized: localStorage.getItem('crimeAdvisor.min') === '1',

  // Sit in the page, just above the crimes app (outside React's tree), so Torn's chat can't cover it.
  // Falls back to a floating box in the bottom-left if that spot isn't there.
  place() {
    const anchor = document.getElementById('react-root');
    if (anchor && anchor.parentNode) {
      if (this.el.nextSibling !== anchor || this.el.parentNode !== anchor.parentNode) anchor.parentNode.insertBefore(this.el, anchor);
      this.mode = 'inline';
    } else if (!this.el.isConnected) {
      document.body.appendChild(this.el);
      this.mode = 'float';
    }
  },

  mount() {
    if (this.el || !document.body) return;
    const style = h('style'); style.textContent = CSS; document.head.appendChild(style);
    this.el = h('div'); this.el.id = 'ca-panel';
    this.mode = 'float';
    this.place();
    window.addEventListener('hashchange', () => this.render());
    this.render();
    // The crimes app loads after us; keep re-checking our spot for a while, then just refresh labels.
    let tries = 0;
    const t = setInterval(() => { const m = this.mode; this.place(); if (m !== this.mode) this.render(); if (++tries > 30) clearInterval(t); }, 1000);
    setInterval(() => { this.place(); this.render(); }, 60000);
  },

  render() {
    if (!this.el) return;
    const data = Store.load();
    const { top, rows } = rankAll(data);
    Store.save(); // analyzers may update outage timers
    const el = this.el;
    el.className = [this.mode === 'inline' ? 'ca-inline' : 'ca-float', this.minimized ? 'ca-min' : ''].join(' ');
    el.textContent = '';

    const head = h('div', 'ca-head');
    head.appendChild(h('span', 'ca-title', top ? `Crime Advisor · ${top.name}` : 'Crime Advisor'));
    head.appendChild(h('span', 'ca-sub', `${data.user ? data.user.nerve + 'N · ' : ''}${TCT.label()} ${this.minimized ? '▴' : '▾'}`));
    head.addEventListener('click', () => {
      this.minimized = !this.minimized;
      localStorage.setItem('crimeAdvisor.min', this.minimized ? '1' : '0');
      this.render();
    });
    el.appendChild(head);

    const outer = h('div', 'ca-body');
    el.appendChild(outer);
    let body = h('div', 'ca-col');
    outer.appendChild(body);
    const right = h('div', 'ca-col');
    outer.appendChild(right);

    // Top pick
    const box = h('div', 'ca-top');
    if (top) {
      const l = h('div', 'ca-line');
      l.appendChild(h('b', null, `Do: ${top.name}`));
      l.appendChild(h('span', null, `${fmt.perN(top.rate)} (${top.source})`));
      box.appendChild(l);
      box.appendChild(h('div', null, top.note));
      const bestOpt = (top.options || []).find(o => o.best);
      if (bestOpt) box.appendChild(h('div', 'ca-dim', `${bestOpt.label}: ${bestOpt.detail}`));
    } else {
      box.appendChild(h('div', null, 'Open the crimes you do so the Advisor can read them.'));
    }
    body.appendChild(box);

    // This page
    const here = currentCrime();
    const hereRow = here && rows.find(r => r.typeID === here);
    if (hereRow && hereRow.options && hereRow.options.length) {
      body.appendChild(h('h4', null, `On this page · ${hereRow.name}`));
      hereRow.options.slice(0, 10).forEach(o => {
        const r = h('div', 'ca-row');
        r.appendChild(h('div', o.best ? 'ca-best' : null, (o.best ? '★ ' : '') + o.label));
        r.appendChild(h('div', 'ca-dim', o.detail));
        body.appendChild(r);
      });
    }

    // Full list (right column when inline)
    body = right;
    body.appendChild(h('h4', null, 'All crimes, best first'));
    rows.forEach(r => {
      const row = h('div', 'ca-row');
      const l = h('div', 'ca-line');
      l.appendChild(h('span', r === top ? 'ca-best' : (r.actionable ? null : 'ca-dim'), r.name));
      l.appendChild(h('span', r.rate !== null && r.rate < 0 ? 'ca-neg' : null, r.rate !== null ? fmt.perN(r.rate) : r.source));
      row.appendChild(l);
      const sub = [r.note, r.why, r.seenAt ? `seen ${fmt.ago(r.seenAt)}` : null].filter(Boolean).join(' · ');
      row.appendChild(h('div', 'ca-dim', sub));
      body.appendChild(row);
    });

    const foot = h('div', 'ca-line');
    foot.style.marginTop = '8px';
    foot.appendChild(h('span', 'ca-dim', 'Read-only: never clicks or requests anything.'));
    const reset = h('button', null, 'Reset data');
    reset.addEventListener('click', e => {
      e.stopPropagation();
      if (confirm('Clear everything the Crime Advisor has learned?')) { Store.reset(); this.render(); }
    });
    foot.appendChild(reset);
    body.appendChild(foot);
  },
};
