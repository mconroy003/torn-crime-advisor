// ---------- main ----------
const pageWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
installHooks(pageWin, () => UI.render());
try { pageWin.crimeAdvisorExport = exportRaw; pageWin.crimeAdvisorSet = setSetting; } catch { /* ignore */ }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => UI.mount());
else UI.mount();
