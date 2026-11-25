// Runs the analyzers against captured responses (test/fixtures, not committed).
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';
const mem = {};
const ctx = { console, URL, Date, JSON, Math, Number, String, Object, Array,
  localStorage: { getItem: k => mem[k] ?? null, setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } } };
vm.createContext(ctx);
for (const f of ['core', 'reference', 'data', 'react', 'crimes', 'plan']) vm.runInContext(readFileSync(`src/${f}.js`, 'utf8') + '\n;globalThis.__x=1', ctx);
const run = code => vm.runInContext(code, ctx);
// Pin the clock for checks that depend on the day of the capture.
function atTime(iso) { const t = Date.parse(iso); class D extends Date { constructor(...a) { super(...(a.length ? a : [t])); } static now() { return t; } } ctx.Date = D; }

let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };

// Unit checks
run('globalThis.t = parseRequest("/page.php?sid=crimesData&step=crimesList", JSON.stringify({typeID:"9"}))');
ok(run('t.typeID') === 9 && run('t.step') === 'crimesList', 'typeID from request body');
run('globalThis.t2 = parseRequest("/page.php?sid=crimesData&step=attempt&typeID=7&crimeID=68&value1=133", null)');
ok(run('t2.typeID') === 7 && run('t2.crimeID') === '68', 'typeID + crimeID from attempt URL');

// Earnings attribution
run(`Store.reset();
handleResponse('/page.php?sid=crimesData&step=crimesList', '{"typeID":"9"}', {DB:{crimesByType:{objects:[]},currentUserStats:{moneyFoundTotal:1000,nerveUsed:100}}}, 1);
handleResponse('/page.php?sid=crimesData&step=attempt&typeID=9&crimeID=199', null, {DB:{currentUserStats:{moneyFoundTotal:121000,nerveUsed:106}}}, 2);`);
ok(run('Store.load().actions["9:199"].money') === 120000 && run('Store.load().actions["9:199"].nerve') === 6, 'attempt payout attributed to action 9:199');

if (!existsSync('test/fixtures/c2.json')) { console.log('no fixtures; skipping capture tests'); process.exit(fails ? 1 : 0); }
run('Store.reset()');
for (const file of ['c2.json', 'c3.json']) {
  const cap = JSON.parse(readFileSync(`test/fixtures/${file}`, 'utf8'));
  for (const [key, list] of Object.entries(cap)) {
    if (key.startsWith('unknown')) continue;
    for (const e of [...list].reverse()) {
      ctx.__e = e;
      run('handleResponse(__e.url, __e.requestBody, __e.response, Date.parse(__e.capturedAt))');
    }
  }
}
atTime('2026-11-23T21:00:00Z');
const res = run('rankAll(Store.load())');
console.log('\nTOP PICK:', res.top && `${res.top.name} ${run('fmt.perN')(res.top.rate)} — ${res.top.note}`);
for (const r of res.rows) console.log(`  ${r.actionable ? '•' : ' '} ${r.name.padEnd(16)} ${String(r.rate === null ? r.source : Math.round(r.rate)).padStart(10)}  ${r.note}${r.why ? ' | ' + r.why : ''}`);
for (const id of [9, 10, 4, 1, 7]) {
  const r = res.rows.find(x => x.typeID === id);
  console.log(`\n[${r.name}]`); r.options.slice(0, 4).forEach(o => console.log(`  ${o.best ? '★' : ' '} ${o.label} — ${o.detail}`));
}
ok(res.rows.length === 13, 'all 13 crimes ranked');
ok(res.rows.find(r => r.typeID === 9).options.length > 0, 'disposal jobs found');
ok(res.rows.find(r => r.typeID === 10).options.length > 0, 'cracking targets found');
let Store_size; ok(JSON.stringify(Store_size = run('localStorage.getItem("crimeAdvisor.v1").length')) && Store_size < 2_000_000, `stored state size ${Store_size} bytes`);


function require_write() { import('node:fs').then(fs => fs.writeFileSync('/tmp/ca-state.json', mem['crimeAdvisor.v1'] || '{}')); }

// Time travel: Tuesday 08:30 TCT (after midnight reset)
if (existsSync('test/fixtures/c2.json')) {
  const realNow = Date.now;
  const fake = Date.parse('2026-11-24T08:30:00Z');
  class FakeDate extends Date { constructor(...a) { super(...(a.length ? a : [fake])); } static now() { return fake; } }
  ctx.Date = FakeDate;
  const t = run('rankAll(Store.load())');
  console.log('\n--- Tue 08:30 TCT ---\nTOP PICK:', t.top && t.top.name);
  for (const r of t.rows) console.log(`  ${r.actionable ? '•' : ' '} ${r.name.padEnd(16)} ${r.newDay ? '[new]' : r.stale ? '[stale]' : '      '} ${r.note}`);
  const sfc = t.rows.find(r => r.typeID === 1); sfc.options.forEach(o => console.log('    SFC', o.label, o.detail));
  ok(t.rows.find(r => r.typeID === 9).newDay, 'Disposal flagged as new day after midnight');
  ok(t.rows.find(r => r.typeID === 10).options.length === 0, 'old Cracking targets dropped after midnight');
  ok(sfc.options.some(o => o.detail.includes('clock')), 'Search for Cash uses clock estimates when old');
  ctx.Date = Date;
}

// Nerve plan with 130N
if (existsSync('test/fixtures/c2.json')) {
  atTime('2026-11-23T21:00:00Z');
  ctx.__rows = run('rankAll(Store.load()).rows');
  const plan = run('planNerve(__rows, {cur:130, max:130})');
  const plan64 = run('planNerve(__rows.filter(r => r.typeID !== 10), {cur:70, max:130})');
  console.log('\nPLAN 130N:', run('planText')(plan, { cur: 130 }));
  ok(plan.steps.length > 0 && plan.left < 130, 'planner spends nerve');
  ok(plan64.steps.some(s => s.crime === 'Forgery'), 'Forgery Passport counts in the plan once materials are known');
  ok(run('capWarning({cur:120,max:130})') === 'Nerve full in ~50 min', 'cap warning within the hour');
  const burg = run('rankAll(Store.load()).rows').find(r => r.typeID === 7);
  ok(!/Could not read/.test(burg.note), 'Burglary reads');
  console.log('  Burglary:', burg.note, '|', (burg.options[0] || {}).short);
}

// Fix: a crack attempt that leaves out the rig section must not change the nerve estimate.
if (existsSync('test/fixtures/c2.json')) {
  atTime('2026-11-23T21:00:00Z');
  const before = run('rankAll(Store.load()).rows').find(r => r.typeID === 10).rate;
  ctx.__t = JSON.parse(JSON.stringify(run('Store.load().state[10].db.crimesByType.targets')));
  ctx.__now = Date.parse('2026-11-23T21:00:00Z');
  run(`handleResponse('/page.php?sid=crimesData&step=attempt&typeID=10&crimeID=205', null, {DB:{crimesByType:{targets:__t}}}, __now)`);
  const after = run('rankAll(Store.load()).rows').find(r => r.typeID === 10).rate;
  ok(Math.abs(after - before) < 1, `Cracking estimate kept after an attempt without rig data (${Math.round(before)} → ${Math.round(after)})`);
}

// Fix: scam targets that are hesitating or have a concern aren't "reply now".
{
  const st = { targetsScammedSucc: 800, targetsScammedFail: 200, moneyAwarded: 112e6, crimesByIDAttempts: { 291: 400, 292: 7000 }, concernsAttempts: 400, concernsResolved: 140 };
  ctx.__db = (targets) => ({ crimesByType: { targets, methods: [], farming: { currentOngoing: [{ type: 'scraper', currentValue: 10 }] } }, stats: st });
  const hes = run(`Analyzers[12](__db([{ title: 'A', state: { name: 'Hesitation' } }]), Store.load(), {})`);
  ok(hes.steps[0].wait && !hes.actionable, `hesitating target → wait (${hes.note})`);
  const con = run(`Analyzers[12](__db([{ title: 'B', zone: 'concern' }]), Store.load(), {})`);
  ok(/Resolve the concern/.test(con.steps[0].action), `concern target → resolve (${con.steps[0].action})`);
  const mix = run(`Analyzers[12](__db([{ title: 'A', state: 'hesitation' }, { title: 'C', expire: ${Math.floor(Date.now() / 1000) + 3600} }]), Store.load(), {})`);
  ok(/Reply to 1 target/.test(mix.steps[0].action), `normal target with an expiry is still replyable (${mix.steps[0].action})`);
}

// Arson: light hands-off jobs first, never "continue" one that's burning on its own, watch ceiling jobs.
{
  const st = { rewardsCollected: 1330, moneyFoundTotal: 77.5e6, nerveUsed: 30873 };
  const job = (title, icon, actions, damage = null) => ({ title, icons: [icon], availableActions: actions, damage });
  ctx.__adb = { crimesByType: { targets: [
    job('Shack', { type: 'C2', title: 'Total destruction required' }, [{ title: 'Stoke', nerve: 5 }, { title: 'Dampen', nerve: 5 }], 40),
    job('Post Office', { type: 'C3', title: 'Less than 20% damage required' }, [{ title: 'Make Entry', nerve: 3 }]),
    job('Car Wash', { type: 'C4', title: 'More than 25% damage required' }, [{ title: 'Make Entry', nerve: 3 }]),
  ], availableItems: [] }, stats: st };
  const a = run('Analyzers[13](__adb, Store.load(), {})');
  ok(/^Light Car Wash/.test(a.steps[0].action), `hands-off job lit first (${a.steps[0].action})`);
  ok(!a.steps.some(x => /Shack/.test(x.action)), 'burning total-destruction job is left alone');
  ok(a.steps.some(x => /Post Office.*Less than 20%/.test(x.action)), 'ceiling job listed as one to work and watch');
  ok(/1 burning on their own/.test(a.note), `note counts the fire burning alone (${a.note.slice(-40)})`);
}

// Forgery: retry-based nerve and material cost
{
  atTime('2026-11-23T21:00:00Z');
  const f = run('rankAll(Store.load())').rows.find(r => r.typeID === 11);
  const pp = f.options.find(o => o.key === 'Passport');
  console.log('  Passport:', pp.short, '|', pp.detail, '| gross', Math.round(pp.gross));
  ok(pp.gross > 9200 && pp.gross < 9700, `Passport gross ~ $9.5k/N with your step success (${Math.round(pp.gross)})`);
  ok(Math.abs(pp.perN - 8000) < 250, `Passport net ~ $8k/N after assumed materials (${Math.round(pp.perN)})`);
  run("setSetting('materials', 'Passport', 150000)");
  const pp2 = run('rankAll(Store.load())').rows.find(r => r.typeID === 11).options.find(o => o.key === 'Passport');
  ok(pp2.perN < pp.perN && /yours/.test(pp2.detail), `your material cost overrides the assumption (${Math.round(pp2.perN)}/N)`);
  run("setSetting('materials', 'Passport', null)");
}

// Hustling: no audience → nothing to do
{
  const h = run(`Analyzers[8]({ crimesByType: { shill: { additionalInfo: { moneyToCollect: 0 } }, pickpocket: { additionalInfo: { moneyToCollect: 0 } }, audience: { additionalInfo: { currentAudience: [] } } }, stats: { totalMoneyWon: 1, totalMoneyLost: 2 } }, Store.load(), {})`);
  ok(!h.actionable && /no audience/.test(h.note), `Hustling with no crowd → skip (${h.note.slice(0, 60)})`);
}

// Deep-dive fixes
{
  atTime('2026-11-23T21:00:00Z');
  const rows = run('rankAll(Store.load())').rows;
  const disp = rows.find(r => r.typeID === 9);
  const db = disp.options.find(o => o.key === 'Dead Body');
  ok(db && db.perN > 10000, `Dead Body valued at Emforus's ~18k/N, not your blended Disposal rate (${db && Math.round(db.perN)})`);
  const skim = rows.find(r => r.typeID === 6);
  ok(/Bus Station or Post Office/.test(skim.note) && !/Install 0/.test(skim.note), 'Card Skimming suggests faster locations, no assumed slot cap');
}

require_write(); await new Promise(r => setTimeout(r, 50));
process.exit(fails ? 1 : 0);
