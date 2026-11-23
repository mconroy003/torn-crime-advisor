# Torn Crime Advisor

A read-only userscript for Torn Crimes 2.0. It tells you which crime to spend nerve on right now, and which option to pick on each crime page.

- **Read-only.** It reads the crime data your crime pages already load. It never clicks, never submits, and never sends requests to Torn (1 click = 1 action).
- **Your real numbers.** Cash per nerve comes from your own totals (`moneyFoundTotal` / `nerveUsed`) per crime. Lifetime until you've spent 60 nerve on a crime after installing, then only what you've earned since.
- **Learns per action.** Every crime attempt returns your new totals, so the script records what each action actually paid.

## Install

1. Install Tampermonkey (desktop) or open TornPDA's userscript settings.
2. Open https://raw.githubusercontent.com/mconroy003/torn-crime-advisor/main/dist/crime-advisor.user.js and click Install. Tampermonkey checks that URL for updates.
3. Open the Crimes page and visit each crime once. The panel in the bottom-right fills in.

## What v0.1 covers

| Crime | What it shows |
| --- | --- |
| Disposal | Best method per job, from your success rates; Dead Body first |
| Cracking | Next target by estimated $/N, using your rig's brute-force power |
| Shoplifting | Stores with security down and how long since first seen |
| Search for Cash | Location with the highest bar right now |
| Burglary | Scouted targets, confidence, missing tools, expiry |
| Others | One-line status: store stock, skimmers, accomplice money, Arson collects |

## Develop

```
npm run build   # src/*.js -> dist/crime-advisor.user.js
npm test        # runs analyzers against captured responses in test/fixtures (not committed)
```
