// Runs the analyzers against captured responses (test/fixtures, not committed).
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';
const mem = {};
const ctx = { console, URL, Date, JSON, Math, Number, String, Object, Array,
  localStorage: { getItem: k => mem[k] ?? null, setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } } };
vm.createContext(ctx);
for (const f of ['core', 'reference', 'prices', 'data', 'react', 'crimes', 'plan']) vm.runInContext(readFileSync(`src/${f}.js`, 'utf8') + '\n;globalThis.__x=1', ctx);
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

// Scam targets from a real export: hesitation cooldown, concern tile, safest reply.
if (existsSync('test/fixtures/e1.json')) {
  const ex = JSON.parse(readFileSync('test/fixtures/e1.json', 'utf8'));
  const t = ex.raw['12:crimesList'].response.DB.crimesByType.targets[0];
  ctx.__t = t;
  const st = { targetsScammedSucc: 800, targetsScammedFail: 200, moneyAwarded: 112e6, crimesByIDAttempts: { 291: 400, 292: 7000 }, concernsAttempts: 400, concernsResolved: 140 };
  ctx.__db = (targets) => ({ crimesByType: { targets, methods: [], farming: { currentOngoing: [{ type: 'phisher', currentValue: 10 }] } }, stats: st });
  atTime(new Date((t.cooldown - 60) * 1000).toISOString());
  const w = run(`Analyzers[12](__db([__t]), Store.load(), {})`);
  ok(w.steps[0].wait && !w.actionable, `hesitating (cooldown running) → wait (${w.steps[0].action})`);
  atTime(new Date((t.cooldown + 60) * 1000).toISOString());
  const r = run(`Analyzers[12](__db([__t]), Store.load(), {})`);
  ok(/^Reply to 1 target/.test(r.steps[0].action) && /safest reply/.test(r.steps[0].action), `cooldown over → reply, with safest move (${r.steps[0].action.slice(0, 120)})`);
  const c = run(`Analyzers[12](__db([Object.assign({}, __t, { cooldown: 0, barPosition: 'concern' })]), Store.load(), {})`);
  ok(/Resolve the concern/.test(c.steps[0].action), 'on a concern tile → resolve');
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

// Item prices (mocked API v1 response)
{
  atTime('2026-11-23T21:00:00Z');
  run(`Prices.ingest({ 1: { name: 'Cardstock', market_value: 9000 }, 2: { name: 'Bonded Latex', market_value: 20000 }, 3: { name: 'Glue', market_value: 5000 },
    4: { name: 'Toner', market_value: 15000 }, 5: { name: 'Bond Paper', market_value: 8000 }, 6: { name: 'Adhesive Plastic', market_value: 12000 },
    206: { name: 'Xanax', market_value: 830000 }, 172: { name: 'Gasoline', market_value: 3000 }, 1457: { name: 'Kerosene', market_value: 40000 },
    7: { name: 'Passport', market_value: 610000 } }, Date.now())`);
  const pp = run('rankAll(Store.load())').rows.find(r => r.typeID === 11).options.find(o => o.key === 'Passport');
  console.log('  Passport priced:', pp.short, '|', pp.detail);
  ok(/market prices/.test(pp.detail) && /item market/.test(pp.detail), 'Passport materials from prices; market sale beats the Print Store');
  ok(Math.abs(pp.perN - (610000 - 74000) / pp.nerve) / pp.perN < 0.01, `net = (market sale − priced materials) ÷ nerve (${Math.round(pp.perN)})`);
  const cyc = run(`Analyzers[5]({ crimesByType: [{ title: 'Cyclist', crimeID: 31, nerve: 5 }], stats: { crimesByIDAttempts: { 31: 100 }, crimesByIDAttemptsSucc: { 31: 90 } } }, Store.load(), {})`).options[0];
  ok(cyc.perN > 10000 && cyc.perN < 13000, `cyclist valued from the Xanax price (${Math.round(cyc.perN)}/N)`);
  // Arson: item counts drop on an attempt -> tracked as used
  ctx.__s = (gas, ker, nerve) => ({ DB: { crimesByType: { targets: [], availableItems: [{ itemID: 172, total: gas }, { itemID: 1457, total: ker }] }, currentUserStats: { moneyFoundTotal: 77496500, nerveUsed: nerve, rewardsCollected: 1330 } } });
  run(`handleResponse('/page.php?sid=crimesData&step=crimesList', '{"typeID":"13"}', __s(111, 23, 30873), Date.now())`);
  for (let i = 0; i < 5; i++) run(`handleResponse('/page.php?sid=crimesData&step=attempt&typeID=13&crimeID=331', null, __s(${110 - i}, ${22 - i}, ${30878 + i * 5}), Date.now())`);
  const ic = run('itemCostPerNerve(Store.load(), 13)');
  ok(ic && ic.value === 5 * 3000 + 5 * 40000 && ic.nerve === 25, `Arson items used tracked: ${ic && fmt_(ic.value)} over ${ic && ic.nerve}N`);
}
function fmt_(n) { return '$' + Math.round(n).toLocaleString('en-US'); }

// Friend's Forgery: 18 Passports in progress
if (existsSync('test/fixtures/friend.json')) {
  const fr = JSON.parse(readFileSync('test/fixtures/friend.json', 'utf8'));
  ctx.__f = fr.raw['11:crimesList'].response;
  atTime(fr.raw['11:crimesList'].at);
  run('Store.reset()');
  run(`handleResponse('/page.php?sid=crimesData&step=crimesList', '{"typeID":"11"}', __f, Date.now())`);
  const f = run('rankAll(Store.load())').rows.find(r => r.typeID === 11);
  console.log('  Friend Forgery:', f.note);
  ok(/Advance 16 projects, furthest along first: .*Lamination/.test(f.note), 'advance in-progress Passports, furthest first');
  ok(/2 blocked: need Bonded Latex/.test(f.note) && /buy more: Cardstock/.test(f.note), 'flags blocked projects and Cardstock running out');
  // Measured materials: a step that uses 5% of a Glue
  const next = JSON.parse(JSON.stringify(ctx.__f));
  next.DB.crimesByType.projects.forEach(p => (p.additionalInfo.usableItems || []).forEach(u => { if (u.label === 'Glue') u.amount -= 5; }));
  next.DB.currentUserStats.nerveUsed += 5;
  ctx.__n = next;
  run(`handleResponse('/page.php?sid=crimesData&step=attempt&typeID=11&crimeID=287', null, __n, Date.now())`);
  const u = run('Store.load().used[11]');
  ok(Math.abs(u.names.Glue - 0.05) < 1e-9 && u.nerve === 5, `material use measured: ${u.names.Glue.toFixed(2)} of a Glue over ${u.nerve}N`);
}

// Out of nerve + switch explanation
{
  run('Store.reset()');
  const plan0 = run('planNerve([], {cur:0, max:130})');
  ok(/^Out of nerve \(0N\): you'll have 5N around/.test(run('planText')(plan0, { cur: 0, max: 130 })), 'out of nerve says when you can act again');
  ctx.__rows = [{ typeID: 10, name: 'Cracking', actionable: true, rate: 8000, options: [] }, { typeID: 12, name: 'Scamming', actionable: true, rate: 4000, options: [] }];
  run('Store.load().lastTop = { typeID: 10, at: Date.now() }');
  ctx.__rows2 = [{ typeID: 12, name: 'Scamming', actionable: true, rate: 4000, note: 'Next: Send a wave', options: [] }, { typeID: 10, name: 'Cracking', actionable: true, rate: 3600, note: 'Next: Judge', options: [] }];
}

// Switch explanation through the real ranking (your capture)
if (existsSync('test/fixtures/c2.json')) {
  run('Store.reset()');
  for (const file of ['c2.json']) {
    const cap = JSON.parse(readFileSync(`test/fixtures/${file}`, 'utf8'));
    for (const [key, list] of Object.entries(cap)) { if (key.startsWith('unknown')) continue; for (const e of [...list].reverse()) { ctx.__e = e; run('handleResponse(__e.url, __e.requestBody, __e.response, Date.parse(__e.capturedAt))'); } }
  }
  atTime('2026-11-23T21:00:00Z');
  run('Store.load().lastTop = { typeID: 12, at: Date.now() - 60000 }');
  const t = run('rankAll(Store.load())').top;
  console.log('  switch note:', t.name, '|', t.switchedFrom);
  ok(t.typeID !== 12 && /^Scamming is now/.test(t.switchedFrom || ''), 'top-pick switch is explained');
}

require_write(); await new Promise(r => setTimeout(r, 50));
process.exit(fails ? 1 : 0);
