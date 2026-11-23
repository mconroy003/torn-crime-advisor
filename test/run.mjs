// Runs the analyzers against captured responses (test/fixtures, not committed).
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';
const mem = {};
const ctx = { console, URL, Date, JSON, Math, Number, String, Object, Array,
  localStorage: { getItem: k => mem[k] ?? null, setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } } };
vm.createContext(ctx);
for (const f of ['core', 'data', 'crimes']) vm.runInContext(readFileSync(`src/${f}.js`, 'utf8') + '\n;globalThis.__x=1', ctx);
const run = code => vm.runInContext(code, ctx);
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
require_write(); await new Promise(r => setTimeout(r, 50));
process.exit(fails ? 1 : 0);
function require_write() { import('node:fs').then(fs => fs.writeFileSync('/tmp/ca-state.json', mem['crimeAdvisor.v1'] || '{}')); }
