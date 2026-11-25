# Torn Crime Advisor

A read-only userscript for Torn Crimes 2.0. It tells you which crime to spend nerve on right now, and which option to pick on each crime page.

- **Read-only.** It reads the crime data your crime pages already load. It never clicks, never submits, and never sends requests to Torn (1 click = 1 action).
- **Your real numbers.** Cash per nerve comes from your own totals (`moneyFoundTotal` / `nerveUsed`) per crime. Lifetime until you've spent 60 nerve on a crime after installing, then only what you've earned since.
- **Learns per action.** Every crime attempt returns your new totals, so the script records what each action actually paid.

## Install

1. Install Tampermonkey (desktop) or open TornPDA's userscript settings.
2. Open https://raw.githubusercontent.com/mconroy003/torn-crime-advisor/main/dist/crime-advisor.user.js and click Install. Tampermonkey checks that URL for updates.
3. Open the Crimes page and visit each crime once. The panel in the bottom-right fills in.

## How the numbers work

- **Starting estimates (no spreadsheets):** public payout ranges from the Torn wiki × your own success rate for that option ÷ its nerve cost. Used for Cracking, Pickpocketing, Burglary and Forgery.
- **Your results take over:** every attempt returns your new cash total, so each option moves toward what it actually paid you (half-way after 5 tries).
- **Recent over lifetime:** each crime's rate uses your last 14 days, blended with lifetime until you've spent enough nerve recently.
- **Shown but not picked:** estimates that leave out known costs or uncertain cash (Forgery materials, Burglary and Pickpocketing before you have your own tries) appear on the page but never become the top pick.
- **Nerve plan:** the Hub line reads your nerve from the sidebar and lists what to spend it on, best $/N first, and warns when nerve will be full within the hour.
- **Backup read:** if the page loaded its crime data before the script was listening, it reads the same data from the rendered page.

## Item prices (optional API key)

Click **Add API key** on the Advisor's green line and paste a Torn API key (Public access). With prices, the Advisor:

- prices Forgery materials at market value (and tells you when the item market pays more than the Print Store),
- subtracts the accelerants Arson actually used, tracked from your item counts before and after each action,
- values cyclists by the Xanax they drop.

| Data storage | Data sharing | Purpose of use | Key storage & sharing | Key access level |
| --- | --- | --- | --- | --- |
| Item prices cached in your browser for 6 hours; crime stats in your browser | Nobody: nothing leaves your browser except the price request to api.torn.com | Valuing items used and earned by crimes | Stored in your browser's local storage only; sent only to api.torn.com | Public (one `torn > items` request every 6 hours) |

If Torn rejects the key (invalid, paused or too limited), the Advisor stops using it until you enter a new one, as Torn's API rules ask.

**Export data** on the same line downloads what the Advisor has saved (no API key included), for troubleshooting.

## Between visits

The script can only read a crime while you have it open, so it fills the gaps itself:

- **Daily jobs:** after 00:00 TCT, Disposal, Cracking and Arson show "new jobs" and drop yesterday's list.
- **Your own actions:** every attempt returns fresh data, so jobs done, cracking progress and burglary confidence stay current as you play.
- **Search for Cash:** Trash, Junkyard, Cemetery and Fountain are estimated from their schedules when the last look is over an hour old.
- **Expiry:** expired Cracking and Burglary targets are dropped by the clock.
- **Stale flags:** only random, short-lived state (Shoplifting security, Pickpocketing targets, Scamming replies) shows "checked X ago" on the Hub.

## What it covers

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
