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

function planText(plan, nerve) {
  if (!nerve) return '';
  const parts = plan.steps.slice(0, 4).map(s =>
    `${s.crime}${s.label ? ': ' + s.label : ''}${s.count > 1 ? ' ×' + s.count : ''} (${s.count * s.nerve}N, ${fmt.perN(s.perN)})`);
  let t = `With ${nerve.cur}N: ` + (parts.length ? parts.join(' → ') : 'nothing worth it yet');
  if (plan.look && plan.look.length) t = `Open ${plan.look.join(', ')} first (new since 00:00 TCT) · ` + t;
  return t;
}
