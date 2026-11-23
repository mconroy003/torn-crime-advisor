// ---------- reference: public payout ranges from the Torn wiki ----------
// Starting estimates only. Each option moves toward your own results as you play (see blend()).
// Sources: wiki.torn.com pages for Cracking, Pickpocketing, Burglary and Forgery (read Nov 2026).

const REF = {
  // Cracking target → cash range
  cracking: {
    'colleague': [10e3, 30e3], 'ex-boyfriend': [10e3, 30e3], 'ex-girlfriend': [10e3, 30e3],
    'ex-husband': [10e3, 30e3], 'ex-wife': [10e3, 30e3], 'online adversary': [10e3, 30e3],
    'romantic interest': [10e3, 30e3], 'friend': [10e3, 25e3], 'neighbor': [10e3, 25e3], 'neighbour': [10e3, 25e3],
    'informant': [30e3, 50e3], 'juror': [30e3, 50e3], 'doctor': [35e3, 140e3], 'judge': [40e3, 99.6e3],
    'hacker': [50e3, 199.8e3], 'police officer': [40e3, 90e3], 'government official': [70e3, 130e3],
    'politician': [60e3, 119.9e3], 'pornography network': [80.5e3, 149.8e3], 'campus network': [60e3, 180e3],
    'health service': [80.1e3, 150e3], 'games developer': [60.1e3, 149e3], 'rival corporation': [80.1e3, 250e3],
    'police department': [100.3e3, 250e3], 'criminal syndicate': [100.3e3, 348.5e3], 'government': [150.2e3, 499.4e3],
    'internet service provider': [175e3, 294.9e3], 'armed forces': [400e3, 749.8e3], 'intelligence agency': [402.6e3, 997.6e3],
  },
  // Pickpocketing mark → cash range (items extra). Mobster and Police Officer cash unknown.
  pickpocketing: {
    'businessman': [1380, 9600], 'businesswoman': [1100, 6000], 'classy lady': [1020, 79400], 'cyclist': [720, 10400],
    'drunk man': [216, 3769], 'drunk woman': [274, 3380], 'elderly man': [460, 5000], 'elderly woman': [460, 4900],
    'gang member': [1660, 7000], 'homeless person': [70, 2921], 'jogger': [560, 4550], 'junkie': [202, 4800],
    'laborer': [560, 4700], 'postal worker': [746, 5792], 'rich kid': [1200, 8000], 'sex worker': [530, 5600],
    'student': [312, 3631], 'thug': [800, 6000], 'young man': [550, 3970], 'young woman': [830, 4960],
  },
  // Burglary property → cash range (items extra). Only properties with a full range on the wiki.
  burglary: {
    'advertising agency': [31522, 76200], 'advertisement agency': [31522, 76200], 'barbershop': [10348, 49866],
    'cleaning agency': [10300, 59450], 'dentists office': [5070, 58900], 'funeral parlor': [5150, 49290],
    'liquor store': [5204, 49180], 'market': [10160, 68500], 'self-storage facility': [10200, 69920],
    'brewery': [5406, 23880], 'farm storage unit': [6670, 79200], 'paper mill': [10580, 59780],
    'printing works': [5030, 149700], 'truckyard': [5578, 146600],
  },
  // Forgery project → Print Store sale price (materials not included)
  forgery: {
    'concert ticket': 3250, 'parking permit': 6500, "driver's license": 5000, 'diploma': 50000,
    'birth certificate': 62500, 'license plate': 95000, 'skeleton key': 80000, 'prescription': 75000,
    'travel visa': 122500, 'bank check': 180000, 'police badge': 230000, 'passport': 580000,
  },
};

const mid = r => (r ? (r[0] + r[1]) / 2 : null);

// Move from the starting estimate toward your own $/N: half-way after 5 attempts, ~2/3 after 10.
function blend(priorPerN, learned) {
  if (!learned || learned.perNerve === null) return { perN: priorPerN, src: priorPerN === null ? 'unknown' : 'estimate' };
  if (priorPerN === null) return { perN: learned.perNerve, src: `yours, ${learned.n} tries` };
  const w = learned.n / (learned.n + 5);
  return { perN: w * learned.perNerve + (1 - w) * priorPerN, src: `${Math.round(w * 100)}% yours, ${learned.n} tries` };
}
