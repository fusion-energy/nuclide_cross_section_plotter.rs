// Drives the page in headless Chromium against fixture data.
//
// The data host is routed to tests/fixtures (see fixture_fetch.mjs): every
// library's `latest.json`, `index.json` for ENDF/B-VIII.1 (Li6 and Li7 only,
// H for photons), and Li6's Arrow files, with `Range` honoured (206) the way
// the real origin does it. With `--no-range` every
// request is answered whole with a 200, the case of a proxy that strips the
// header, and the same steps must still pass. Everything else the page loads
// is served from the repository, so the run needs no network beyond this.
//
// Usage: python3 -m http.server 8000 & node tests/e2e.mjs [--no-range] [--url http://127.0.0.1:8000/]

import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { fixturePath, fixtureLatest } from './fixture_fetch.mjs';

const args = process.argv.slice(2);
const noRange = args.includes('--no-range');
const urlIndex = args.indexOf('--url');
const url = urlIndex >= 0 ? args[urlIndex + 1] : 'http://127.0.0.1:8000/';
const SHOTS = new URL('./screenshots/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

const requests = [];
await page.route('https://yamc-data.xsplot.com/**', (route) => {
  const pathname = new URL(route.request().url()).pathname;
  const path = fixturePath(pathname);
  const range = route.request().headers()['range'];
  requests.push({ pathname, range: range ?? null });
  if (path?.latest) return route.fulfill({ status: 200, json: fixtureLatest(path.latest) });
  if (!path || !existsSync(path)) return route.fulfill({ status: 404, body: 'not found' });
  const whole = readFileSync(path);
  if (range && !noRange) {
    const m = /^bytes=(\d+)-(\d+)$/.exec(range);
    return route.fulfill({ status: 206, body: whole.subarray(Number(m[1]), Number(m[2]) + 1), headers: { 'content-type': 'application/octet-stream' } });
  }
  return route.fulfill({ status: 200, body: whole, headers: { 'content-type': path.endsWith('.json') ? 'application/json' : 'application/octet-stream' } });
});

const plot = () => page.evaluate(() => {
  const g = document.getElementById('plot');
  return { names: g.data.map((d) => d.name), lengths: g.data.map((d) => d.x.length), onY2: g.data.map((d) => d.yaxis ?? 'y'), y: g.layout.yaxis.title.text, y2: g.layout.yaxis2?.title.text ?? null, ytype: g.layout.yaxis.type, x: g.layout.xaxis.title.text, x0: g.data[0]?.x[0] ?? null };
});
const step = (name, ok, detail = '') => { console.log(`${ok ? 'ok' : 'FAIL'} - ${name}${detail ? `: ${detail}` : ''}`); if (!ok) process.exitCode = 1; };
const rows = () => page.evaluate(() => [...document.querySelectorAll('#rows tr[data-row]')].map((tr) => tr.innerText.replace(/\s+/g, ' ').trim()));
/// Wait until the table shows exactly one row and it is the one named: the
/// filters are debounced, so the previous row is still there for a moment.
const waitForRow = (text) => page.waitForFunction((t) => {
  const trs = document.querAll ? [] : [...document.querySelectorAll('#rows tr[data-row]')];
  return trs.length === 1 && trs[0].innerText.replace(/\s+/g, ' ').includes(t);
}, text, { timeout: 15000 });

// Only ENDF/B-VIII.1 is fixtured; the hash limits the page to it.
await page.goto(`${url}index.html#l=endf-b8.1`, { waitUntil: 'load' });
await page.waitForFunction(() => document.getElementById('busy').classList.contains('d-none') && document.querySelectorAll('#rows tr[data-row]').length > 0, null, { timeout: 60000 });
const counter = await page.textContent('#counter');
step('table lists Li6, Li7 and photon H', /· \d+ reactions match/.test(counter), counter);

const titles = await page.evaluate(() => [...document.querySelectorAll('#reactions thead tr:first-child th')].map((th) => th.getAttribute('title') ?? ''));
step('every column heading explains itself on hover', titles.length === 7 && titles.every((t) => t.length > 20), `${titles.filter((t) => t.length > 20).length} of ${titles.length} have a title`);

// The library filter is a dropdown of checkboxes; the hash enabled one library.
step('the library filter names the one enabled library', (await page.textContent('#library-filter')) === 'ENDF/B-VIII.1', await page.textContent('#library-filter'));
await page.click('#library-filter');
const menu = await page.evaluate(() => ({ open: !document.getElementById('library-menu').classList.contains('d-none'), boxes: [...document.querySelectorAll('#library-menu input')].map((b) => `${b.value}${b.checked ? '*' : ''}`) }));
step('the dropdown lists all six libraries with ENDF/B-VIII.1 ticked', menu.open && menu.boxes.length === 6 && menu.boxes.filter((b) => b.endsWith('*')).join() === 'endf-b8.1*', JSON.stringify(menu));
await page.keyboard.press('Escape');
step('Escape closes the dropdown', await page.evaluate(() => document.getElementById('library-menu').classList.contains('d-none')));

await page.fill('.filter-input[data-column=element]', 'Li');
await page.fill('.filter-input[data-column=nucleons]', '6');
await page.fill('.filter-input[data-column=reaction]', 't');
await waitForRow('(n,t) 105');
step('typing the product alone finds the reaction', (await rows())[0].includes('(n,t) 105'), (await rows())[0]);
await page.fill('.filter-input[data-column=reaction]', 'n,xt');
await waitForRow('(n,Xt) 205');
await page.fill('.filter-input[data-column=reaction]', '');
await page.fill('.filter-input[data-column=mt]', '105');
await waitForRow('(n,t) 105');
step('filters narrow to one row at 294 K', (await rows())[0] === 'Li 6 (n,t) 105 ENDF/B-VIII.1 294 K', (await rows())[0]);
step('the row checkbox says what ticking it does', (await page.getAttribute('#rows tr[data-row] .row-select', 'title')) === 'Add Li6 (n,t) ENDF/B-VIII.1 294 K to the plot', await page.getAttribute('#rows tr[data-row] .row-select', 'title'));

await page.check('#rows tr[data-row] .row-select');
await page.waitForFunction(() => document.getElementById('plot')?.data?.length === 1, null, { timeout: 60000 });
step('a ticked checkbox offers to remove the series', (await page.getAttribute('#rows tr[data-row] .row-select', 'title')) === 'Remove Li6 (n,t) ENDF/B-VIII.1 294 K from the plot');
let p = await plot();
step('ticking a row draws it at 294 K', p.names[0] === 'Li6 (n,t) ENDF/B-VIII.1 294 K' && p.lengths[0] > 100, JSON.stringify(p.names));
step('the legend shows for a single trace', await page.evaluate(() => document.getElementById('plot').layout.showlegend === true && !!document.querySelector('#plot .legend .traces')));

// The temperature dropdown lists every published temperature, 294 K ticked.
step('the temperature filter starts at 294 K', (await page.textContent('#temperature-filter')) === '294 K', await page.textContent('#temperature-filter'));
await page.click('#temperature-filter');
const tmenu = await page.evaluate(() => [...document.querySelectorAll('#temperature-menu label')].map((l) => l.textContent));
step('the dropdown lists all seven temperatures', tmenu.join(',') === '250 K,294 K,600 K,900 K,1200 K,2500 K,0 K (elastic only)', tmenu.join(','));
// Ticking 2500 K as well lists the reaction at both temperatures; the new row is another tick.
await page.click('#temp-2500K');
await page.waitForFunction(() => document.querySelectorAll('#rows tr[data-row]').length === 2, null, { timeout: 15000 });
step('ticking 2500 K adds its row', (await rows())[1] === 'Li 6 (n,t) 105 ENDF/B-VIII.1 2500 K' && (await page.textContent('#temperature-filter')) === '2 of 7', (await rows()).join(' | '));
step('an active filter is highlighted', await page.evaluate(() => {
  const typed = getComputedStyle(document.querySelector('.filter-input[data-column=element]'));
  const empty = getComputedStyle(document.querySelector('.filter-input[data-column=reaction]'));
  return typed.borderColor !== empty.borderColor && typed.fontWeight !== empty.fontWeight
    && document.getElementById('temperature-filter').classList.contains('narrowed');
}));
await page.keyboard.press('Escape');
await page.check('#rows tr[data-row]:nth-child(2) .row-select');
await page.waitForFunction(() => document.getElementById('plot')?.data?.length === 2, null, { timeout: 60000 });
p = await plot();
step('ticking the 2500 K row adds a trace', p.names[1] === 'Li6 (n,t) ENDF/B-VIII.1 2500 K', JSON.stringify(p.names));
// Back to 294 K only for the rest.
await page.click('#temperature-filter');
await page.click('#temp-2500K');
await page.keyboard.press('Escape');
await waitForRow('(n,t) 105 ENDF/B-VIII.1 294 K');

await page.fill('.filter-input[data-column=mt]', '301');
await waitForRow('heating 301');
await page.check('#rows tr[data-row] .row-select');
await page.waitForFunction(() => document.getElementById('plot')?.data?.length === 3, null, { timeout: 60000 });
p = await plot();
step('heating goes on a right-hand eV·barn axis', p.y2 === 'Heating (eV·barn)' && p.onY2.filter((a) => a === 'y2').length === 1, JSON.stringify(p));

await page.click('#y-scale');
p = await plot();
step('the Y toggle switches to linear', p.ytype === 'linear');

// Sorting cycles ascending, descending, unsorted.
const sortIcon = () => page.evaluate(() => document.querySelector('th[data-column=mt] .sort-icon use').getAttribute('href'));
await page.fill('.filter-input[data-column=mt]', '');
await page.waitForFunction(() => document.querySelectorAll('#rows tr[data-row]').length > 1, null, { timeout: 15000 });
const firstMt = () => page.evaluate(() => document.querySelector('#rows tr[data-row] td:nth-child(5)').textContent);
const unsortedFirst = await firstMt();
await page.click('th[data-column=mt]');
const asc = await sortIcon(); const ascFirst = await firstMt();
await page.click('th[data-column=mt]');
const desc = await sortIcon(); const descFirst = await firstMt();
await page.click('th[data-column=mt]');
const back = await sortIcon();
step('a heading cycles ascending, descending, unsorted', asc === '#icon-sort-up' && desc === '#icon-sort-down' && back === '#icon-sort' && Number(descFirst) > Number(ascFirst) && (await firstMt()) === unsortedFirst, `${asc} / ${desc} / ${back}, first MT ${ascFirst} / ${descFirst} / ${unsortedFirst}`);
await page.fill('.filter-input[data-column=mt]', '301');
await waitForRow('heating 301');

const x0eV = p.x0;
await page.click('#x-unit');
p = await plot();
step('the energy unit toggle rescales the X axis to MeV', p.x === 'Energy (MeV)' && Math.abs(p.x0 - x0eV * 1e-6) < 1e-18 && (await page.textContent('#x-unit')) === 'Energy: MeV', `${p.x} ${p.x0}`);

await page.fill('.filter-input[data-column=element]', 'H');
await page.fill('.filter-input[data-column=nucleons]', '');
await page.fill('.filter-input[data-column=mt]', '');
await page.fill('.filter-input[data-column=reaction]', 'g,coh');
await waitForRow('(gamma,coherent) 502');
step('photon reactions read and type as gamma, not a symbol', (await rows())[0].includes('H photon (gamma,coherent) 502') && !(await rows())[0].includes('γ'), (await rows())[0]);
await page.fill('.filter-input[data-column=reaction]', '');
await page.fill('.filter-input[data-column=mt]', '502');
await waitForRow('(gamma,coherent) 502');
await page.check('#rows tr[data-row] .row-select');
await page.waitForFunction(() => document.getElementById('plot')?.data?.length === 4, null, { timeout: 60000 });
p = await plot();
step('a photon reaction plots without a temperature', p.names[3] === 'H (gamma,coherent) ENDF/B-VIII.1' && (await rows())[0].endsWith('\u2014'), `${p.names[3]} | ${(await rows())[0]}`);

await page.waitForTimeout(300);
const hash = await page.evaluate(() => location.hash);
step('the URL carries the state', hash.includes('s=endf-b8.1:Li6:294:105.301;endf-b8.1:Li6:2500:105;endf-b8.1:H::502') && hash.includes('y=lin') && hash.includes('e=MeV'), hash);

await page.screenshot({ path: `${SHOTS}plot${noRange ? '-no-range' : ''}.png`, fullPage: true });

await page.goto(`${url}index.html${hash}`, { waitUntil: 'load' });
await page.waitForFunction(() => document.getElementById('plot')?.data?.length === 4, null, { timeout: 90000 });
p = await plot();
step('reloading the URL restores the plot', p.names.length === 4 && p.ytype === 'linear' && p.x === 'Energy (MeV)', `${p.x}`);

// Read the download by watching the blob handed to createObjectURL; the real
// URL is still made so the click stays harmless.
const downloaded = await page.evaluate(() => new Promise((resolve) => {
  const orig = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (blob) => { blob.text().then(resolve); return orig(blob); };
  document.getElementById('download-json').click();
  setTimeout(() => { URL.createObjectURL = orig; }, 0);
}));
const parsed = JSON.parse(downloaded);
step('the JSON download has one object per series with units, energies in eV', parsed.length === 4 && parsed.every((s) => s.energy_eV.length === s.xs.length && s.units) && parsed.some((s) => s.units === 'eV barn') && parsed.some((s) => s.temperature_K === 2500) && parsed[0].energy_eV[0] > 1e-6, `${parsed.length} series, first energy ${parsed[0].energy_eV[0]}`);

const errorText = await page.textContent('#error');
step('no error is shown', errorText.trim() === '', errorText.trim());
const ranged = requests.filter((r) => r.range).length;
step(noRange ? 'whole files were used without Range' : 'range requests were used', noRange ? true : ranged > 0, `${requests.length} requests, ${ranged} ranged`);
step('no console errors', errors.length === 0, errors.join(' | '));

await browser.close();
if (process.exitCode) process.exit(process.exitCode);
