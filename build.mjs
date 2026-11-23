// Concatenate src/ into one userscript: node build.mjs
import { readFileSync, writeFileSync } from 'node:fs';
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const repo = process.env.REPO || pkg.repo || '';
const raw = repo ? `https://raw.githubusercontent.com/${repo}/main/dist/crime-advisor.user.js` : '';
const header = `// ==UserScript==
// @name         Torn Crime Advisor
// @namespace    mason.crime-advisor
// @version      ${pkg.version}
// @description  Read-only crime advisor for Torn Crimes 2.0: ranks crimes by your real cash per nerve and picks the best option on each crime page. Never clicks or sends requests.
// @match        https://www.torn.com/loader.php?sid=crimes*
// @match        https://www.torn.com/page.php?sid=crimes*
// @run-at       document-start
// @grant        none
${raw ? `// @updateURL    ${raw}\n// @downloadURL  ${raw}\n` : ''}// ==/UserScript==
`;
const parts = ['core', 'reference', 'data', 'react', 'crimes', 'plan', 'ui', 'main'].map(f => readFileSync(`src/${f}.js`, 'utf8'));
writeFileSync('dist/crime-advisor.user.js', `${header}\n(function () {\n'use strict';\n${parts.join('\n')}\n})();\n`);
console.log('built dist/crime-advisor.user.js', pkg.version, repo || '(no repo set)');
