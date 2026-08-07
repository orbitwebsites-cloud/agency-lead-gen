// Stage 2: Crawl each agency site to confirm it's a real marketing agency,
// find the owner/founder, and pull public contact emails.
// Input: agencies_raw.json -> Output: agencies_enriched.json
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const CONCURRENCY = 14;
const TIMEOUT_MS = 12000;
const UA = 'Mozilla/5.0 (compatible; agency-research/1.0; +mailto:orbitwebsites@gmail.com)';

// Order matters: we cap fetches per site to be polite, so the highest-yield pages
// must come first. /contact is the primary email source and was previously being
// starved by the cap when a site had several /about-style pages.
const PATHS = ['', '/contact', '/about', '/team', '/contact-us', '/about-us', '/our-team', '/leadership'];
const MAX_PAGES = 6;

// Signals that this is genuinely a marketing/SEO/ads/creative agency
const AGENCY_KEYWORDS = [
  'marketing agency','digital agency','seo','search engine optimization','ppc','pay-per-click',
  'google ads','facebook ads','paid media','paid search','social media marketing','content marketing',
  'branding','brand strategy','web design','advertising agency','creative agency','full-service',
  'lead generation','email marketing','media buying','inbound marketing','conversion rate',
];
// Signals this is NOT the ICP (newspapers, printers, franchises, big corps)
const NEGATIVE_KEYWORDS = [
  'subscribe to the print edition','newspaper','obituaries','classifieds','print edition',
  'franchise opportunit','our locations worldwide','fortune 500','nyse:','nasdaq:',
];
const TITLE_WORDS = ['founder','co-founder','cofounder','ceo','chief executive','owner','president','managing director','managing partner','principal'];

const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
const stripTags = (html) => html
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#8217;|&rsquo;/g, "'")
  .replace(/\s+/g, ' ');

const BAD_EMAIL_RE = /\.(png|jpe?g|gif|svg|webp|css|js|woff2?)$/i;
const ROLE_PREFIX = /^(info|hello|contact|support|sales|admin|team|hi|help|office|inquiries|marketing|press|careers|jobs|billing|noreply|no-reply)@/i;

function extractEmails(html, domain) {
  const out = new Set();
  for (const m of html.matchAll(/mailto:([^"'?>\s]+)/gi)) out.add(m[1]);
  for (const m of stripTags(html).matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) out.add(m[0]);
  return [...out]
    .map((e) => e.toLowerCase().trim().replace(/^mailto:/, ''))
    .filter((e) => !BAD_EMAIL_RE.test(e) && e.length < 60 && !e.includes('example.') && !e.includes('sentry.'))
    // keep only emails on the agency's own domain — third-party emails are noise
    .filter((e) => e.split('@')[1]?.replace(/^www\./, '').endsWith(domain.split('.').slice(-2).join('.')));
}

const NAME_RE = /\b([A-Z][a-z]{1,15})\s+([A-Z][a-z'’-]{1,20})\b/;

function extractPeople(html) {
  const people = [];
  // 1) schema.org JSON-LD founder/employee
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const walk = (n) => {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) return n.forEach(walk);
        for (const k of ['founder', 'founders', 'employee', 'author']) {
          const v = n[k];
          if (!v) continue;
          for (const p of [].concat(v)) {
            const nm = typeof p === 'string' ? p : p?.name;
            if (nm && NAME_RE.test(nm)) people.push({ name: clean(nm), title: k === 'founder' || k === 'founders' ? 'Founder' : clean(p?.jobTitle || ''), src: 'jsonld' });
          }
        }
        Object.values(n).forEach(walk);
      };
      walk(JSON.parse(m[1]));
    } catch { /* malformed JSON-LD is common; skip */ }
  }
  // 2) text proximity: a name within ~60 chars of a leadership title
  const text = stripTags(html);
  for (const title of TITLE_WORDS) {
    const re = new RegExp(`(.{0,60})\\b${title}\\b(.{0,60})`, 'gi');
    for (const m of text.matchAll(re)) {
      for (const side of [m[1], m[2]]) {
        const nm = side.match(NAME_RE);
        if (nm) {
          const full = `${nm[1]} ${nm[2]}`;
          if (!/^(The|Our|And|For|With|About|We|Us|This|That|Meet|Contact|Read|View|Learn)\b/.test(full)) {
            people.push({ name: full, title: title.replace(/\b\w/g, (c) => c.toUpperCase()), src: 'text' });
          }
        }
      }
    }
  }
  // dedupe by name, prefer jsonld + founder-ish titles
  const rank = (p) => (p.src === 'jsonld' ? 2 : 0) + (/founder|owner|ceo/i.test(p.title) ? 1 : 0);
  const best = new Map();
  for (const p of people) {
    const k = p.name.toLowerCase();
    if (!best.has(k) || rank(p) > rank(best.get(k))) best.set(k, p);
  }
  return [...best.values()].sort((a, b) => rank(b) - rank(a)).slice(0, 5);
}

async function fetchWithTimeout(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('html')) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength > 3_000_000) return null;
    return new TextDecoder('utf-8', { fatal: false }).decode(buf);
  } catch { return null; }
  finally { clearTimeout(t); }
}

async function enrichOne(rec) {
  const base = `https://${rec.domain}`;
  const pages = [];
  for (const p of PATHS) {
    const html = await fetchWithTimeout(base + p);
    if (html) pages.push({ path: p || '/', html });
    if (pages.length >= MAX_PAGES) break; // enough signal; don't hammer small sites
  }
  if (pages.length === 0) return { ...rec, status: 'unreachable' };

  const allHtml = pages.map((p) => p.html).join('\n');
  const lower = stripTags(allHtml).toLowerCase();

  const matched = AGENCY_KEYWORDS.filter((k) => lower.includes(k));
  const negatives = NEGATIVE_KEYWORDS.filter((k) => lower.includes(k));

  const emails = [...new Set(pages.flatMap((p) => extractEmails(p.html, rec.domain)))];
  const personalEmails = emails.filter((e) => !ROLE_PREFIX.test(e));
  const people = extractPeople(allHtml);

  // rough headcount proxy: distinct capitalized names on the team page
  const teamPage = pages.find((p) => /team|about/.test(p.path));
  let teamSize = null;
  if (teamPage) {
    const names = new Set([...stripTags(teamPage.html).matchAll(new RegExp(NAME_RE, 'g'))].map((m) => `${m[1]} ${m[2]}`));
    teamSize = names.size;
  }

  const title = (allHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim();
  const desc = (allHtml.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i)?.[1] || '').trim();

  return {
    ...rec,
    status: 'ok',
    pages_fetched: pages.map((p) => p.path),
    site_title: clean(title).slice(0, 160),
    site_desc: clean(desc).slice(0, 300),
    agency_signals: matched.slice(0, 12),
    agency_score: matched.length,
    negative_signals: negatives,
    owner_name: people[0]?.name || null,
    owner_title: people[0]?.title || null,
    people: people.map((p) => `${p.name} (${p.title})`),
    emails_all: emails,
    email_personal: personalEmails[0] || null,
    email_role: emails.find((e) => ROLE_PREFIX.test(e)) || rec.email_osm || null,
    team_size_proxy: teamSize,
  };
}

// ---- run with a concurrency pool + resume support ----
if (!existsSync('agencies_raw.json')) {
  console.error(
    '\nagencies_raw.json not found — stage 1 has not completed.\n\n' +
    'Run it first:\n  node 1_harvest_osm.mjs\n\n' +
    'It prints "STAGE 1 COMPLETE" when done. If it exited before that, just run\n' +
    'it again — finished selectors are cached and it resumes where it stopped.\n'
  );
  process.exit(1);
}

const raw = JSON.parse(readFileSync('agencies_raw.json', 'utf8'));
const prior = existsSync('agencies_enriched.json')
  ? JSON.parse(readFileSync('agencies_enriched.json', 'utf8'))
  : [];

// --refresh-missing-email: re-crawl sites we reached but got no email from.
// Useful after changing PATHS/MAX_PAGES, without redoing the whole run.
const REFRESH = process.argv.includes('--refresh-missing-email');
const needsRefresh = (d) =>
  REFRESH && d.status === 'ok' && !d.email_personal && !d.email_role;

const keep = prior.filter((d) => !needsRefresh(d));
const keepDomains = new Set(keep.map((d) => d.domain));
const todo = raw.filter((r) => !keepDomains.has(r.domain));

if (REFRESH) {
  console.log(`Refresh mode: re-crawling ${prior.length - keep.length} email-less records`);
}
console.log(`Enriching ${todo.length} agencies (${keep.length} kept), concurrency ${CONCURRENCY}\n`);

const results = [...keep];
let idx = 0, completed = 0;

async function worker() {
  while (idx < todo.length) {
    const rec = todo[idx++];
    try { results.push(await enrichOne(rec)); }
    catch (e) { results.push({ ...rec, status: 'error', error: e.message }); }
    if (++completed % 25 === 0) {
      const ok = results.filter((r) => r.status === 'ok').length;
      console.log(`  ${completed}/${todo.length}  reachable=${ok}  owners=${results.filter((r) => r.owner_name).length}  emails=${results.filter((r) => r.email_personal || r.email_role).length}`);
      writeFileSync('agencies_enriched.json', JSON.stringify(results, null, 2)); // checkpoint
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
writeFileSync('agencies_enriched.json', JSON.stringify(results, null, 2));

const ok = results.filter((r) => r.status === 'ok');
console.log(`\n=== STAGE 2 COMPLETE ===`);
console.log(`Crawled:            ${results.length}`);
console.log(`Reachable:          ${ok.length}`);
console.log(`Confirmed agency:   ${ok.filter((r) => r.agency_score >= 2 && r.negative_signals.length === 0).length}`);
console.log(`Owner name found:   ${results.filter((r) => r.owner_name).length}`);
console.log(`Personal email:     ${results.filter((r) => r.email_personal).length}`);
console.log(`Role email:         ${results.filter((r) => r.email_role).length}`);
console.log(`\nWrote agencies_enriched.json`);
