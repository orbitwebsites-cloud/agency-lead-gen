// Stage 1: Harvest US marketing/creative agencies from OpenStreetMap (ODbL open data).
// Output: agencies_raw.json
import { writeFileSync } from 'node:fs';

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

async function runQuery(sel) {
  for (const ep of ENDPOINTS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetch(ep, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
          body: new URLSearchParams({ data: buildQuery(sel) }),
        });
        if (!res.ok) {
          if (res.status === 429 || res.status === 504) { await sleep(5000); continue; }
          break; // other error, try next endpoint
        }
        const json = await res.json();
        const els = json.elements || [];
        if (els.length === 0 && attempt === 1) { await sleep(2000); continue; }
        return els;
      } catch {
        await sleep(2000);
      }
    }
  }
  return [];
}

async function harvest() {
  const all = [];
  for (const sel of SELECTORS) {
    process.stdout.write(`  ${sel.padEnd(34)} `);
    const els = await runQuery(sel);
    console.log(`${els.length} elements`);
    all.push(...els);
    await sleep(1500); // be polite to the public Overpass instance
  }
  // dedupe by osm type/id across selectors
  const byId = new Map();
  for (const e of all) byId.set(`${e.type}/${e.id}`, e);
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
