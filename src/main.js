// ---------- main ----------
const pageWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
const pageFetch = (...a) => pageWin.fetch(...a);
installHooks(pageWin, () => UI.render());
try { pageWin.crimeAdvisorExport = exportRaw; pageWin.crimeAdvisorSet = setSetting; } catch { /* ignore */ }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => UI.mount());
else UI.mount();
// Item prices: once on load, then whenever the 6-hour cache runs out.
Prices.refresh(pageFetch).then(ok => { if (ok) UI.render(); });
setInterval(() => Prices.refresh(pageFetch).then(ok => { if (ok) UI.render(); }), 15 * 60 * 1000);
