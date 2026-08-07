// Stage 1: Harvest US marketing/creative agencies from OpenStreetMap (ODbL open data).
// Output: agencies_raw.json
import { writeFileSync, readFileSync, existsSync } from 'node:fs';

// Separate cheap queries — a single combined query with name-regex over the whole
// US times out on Overpass (504). Tag-only selectors are indexed and fast.
const SELECTORS = [
  '["office"="advertising_agency"]',
  '["office"="marketing"]',
  '["office"="graphic_design"]',
  '["office"="web_design"]',
  '["shop"="advertising_agency"]',
  '["office"="newspaper"]',
  '["office"="publisher"]',
];

const buildQuery = (sel) => `
[out:json][timeout:180];
area["ISO3166-1"="US"][admin_level=2]->.us;
nwr${sel}(area.us);
out center tags;
`;

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
];

const UA = 'agency-research/1.0 (contact: orbitwebsites@gmail.com)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FETCH_TIMEOUT_MS = 210000; // Overpass itself is capped at 180s server-side

// Overpass can sit silent for a minute or more. Without a visible heartbeat this
// looks like a hang, and without a client-side abort a stalled socket waits forever.
function startHeartbeat(label) {
  const t0 = Date.now();
  const tick = () => process.stdout.write(`\r  ${label} ${Math.round((Date.now() - t0) / 1000)}s`.padEnd(72));
  tick();
  const id = setInterval(tick, 5000);
  return () => { clearInterval(id); process.stdout.write(`\r${' '.repeat(72)}\r`); };
}

async function runQuery(sel) {
  for (const ep of ENDPOINTS) {
    const host = new URL(ep).hostname;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const stop = startHeartbeat(`${sel} [${host} try ${attempt}]`);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(ep, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
          body: new URLSearchParams({ data: buildQuery(sel) }),
          signal: ctrl.signal,
        });
        if (!res.ok) {
          stop();
          console.log(`    ${host} HTTP ${res.status}${res.status === 429 ? ' (rate limited)' : ''}`);
          if (res.status === 429 || res.status === 504) { await sleep(8000); continue; }
          break; // other error, try next endpoint
        }
        const json = await res.json();
        stop();
        const els = json.elements || [];
        if (els.length === 0 && attempt === 1) { await sleep(3000); continue; }
        return els;
      } catch (e) {
        stop();
        console.log(`    ${host} ${e.name === 'AbortError' ? `timed out after ${FETCH_TIMEOUT_MS / 1000}s` : e.message}`);
        await sleep(3000);
      } finally {
        clearTimeout(timer);
      }
    }
  }
  return [];
}

const CACHE = '.overpass_cache.json';

async function harvest() {
  // Resume across runs: a killed process shouldn't cost you the selectors that
  // already succeeded. Each is cached by selector string.
  let cache = {};
  if (existsSync(CACHE)) {
    try {
      cache = JSON.parse(readFileSync(CACHE, 'utf8'));
      const done = Object.keys(cache).length;
      if (done) console.log(`Resuming: ${done}/${SELECTORS.length} selectors already cached\n`);
    } catch { cache = {}; }
  }

  for (const [i, sel] of SELECTORS.entries()) {
    const prefix = `[${i + 1}/${SELECTORS.length}] ${sel.padEnd(34)}`;
    if (cache[sel]) { console.log(`${prefix} ${cache[sel].length} elements (cached)`); continue; }

    const els = await runQuery(sel);

    if (els.length > 0) {
      cache[sel] = els;
      writeFileSync(CACHE, JSON.stringify(cache)); // checkpoint after every selector
      console.log(`${prefix} ${els.length} elements`);
    } else {
      // Never cache an empty result. Overpass 504s under load, and a cached zero
      // would silently drop this selector from every future run.
      console.log(`${prefix} 0 elements — NOT cached, will retry on next run`);
    }
    await sleep(2000); // be polite to the public Overpass instance
  }

  // dedupe by osm type/id across selectors
  const byId = new Map();
  for (const els of Object.values(cache)) for (const e of els) byId.set(`${e.type}/${e.id}`, e);
  return [...byId.values()];
}

const tag = (e, k) => e.tags?.[k] || e.tags?.[`contact:${k}`] || null;

function normalizeUrl(u) {
  if (!u) return null;
  let s = u.trim();
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try {
    const url = new URL(s);
    if (!url.hostname.includes('.')) return null;
    return url.origin + (url.pathname === '/' ? '' : url.pathname);
  } catch { return null; }
}

const elements = await harvest();

const seen = new Set();
const records = [];

for (const e of elements) {
  const name = e.tags?.name?.trim();
  if (!name) continue;

  const website = normalizeUrl(tag(e, 'website') || tag(e, 'url'));
  if (!website) continue; // no site = no way to find the owner

  let domain;
  try { domain = new URL(website).hostname.replace(/^www\./, '').toLowerCase(); } catch { continue; }

  // dedupe by domain — franchises/chains collapse to one record
  if (seen.has(domain)) continue;
  seen.add(domain);

  records.push({
    osm_id: `${e.type}/${e.id}`,
    name,
    domain,
    website,
    email_osm: tag(e, 'email'),
    phone: tag(e, 'phone'),
    city: e.tags['addr:city'] || null,
    state: e.tags['addr:state'] || null,
    street: e.tags['addr:street'] || null,
    osm_office: e.tags.office || e.tags.shop || null,
    lat: e.lat ?? e.center?.lat ?? null,
    lon: e.lon ?? e.center?.lon ?? null,
  });
}

writeFileSync('agencies_raw.json', JSON.stringify(records, null, 2));

console.log(`\n=== STAGE 1 COMPLETE ===`);
console.log(`Raw elements:        ${elements.length}`);
console.log(`With name + website: ${records.length} (deduped by domain)`);
console.log(`Already have email:  ${records.filter(r => r.email_osm).length}`);
console.log(`Have phone:          ${records.filter(r => r.phone).length}`);
console.log(`Have city/state:     ${records.filter(r => r.city || r.state).length}`);
console.log(`\nWrote agencies_raw.json`);
