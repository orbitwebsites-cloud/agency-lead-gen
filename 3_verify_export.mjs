// Stage 3: MX-verify domains, score against ICP, export CSV.
// Input: agencies_enriched.json -> Output: agency_leads.csv
import { readFileSync, writeFileSync } from 'node:fs';
import { resolveMx } from 'node:dns/promises';
import { cleanEmail, classifyEmail, pickOwner } from './lib.mjs';

const TARGET = Number(process.argv[2]) || 300;

// ICP: US, 2-20 people, full-service digital / SEO / paid ads
const ICP_MIN_TEAM = 2;
const ICP_MAX_TEAM = 20;

const recs = JSON.parse(readFileSync('agencies_enriched.json', 'utf8'));

// Re-derive owner + email classification from raw stage-2 output using the stricter
// validators in lib.mjs. Stage 2's inline heuristics produced ~40% false-positive
// owner names ("Team Matthew", "Direct Mail") and mislabeled role inboxes as personal.
const reachable = recs
  .filter((r) => r.status === 'ok')
  .map((r) => {
    const owner = pickOwner(r.people, r.name);

    const emails = [...new Set((r.emails_all || []).map(cleanEmail).filter(Boolean))];
    const classified = emails.map((e) => ({ e, kind: classifyEmail(e, owner.name) }));
    const personal = classified.find((c) => c.kind === 'personal')?.e || null;
    const generic = classified.find((c) => c.kind === 'generic')?.e || null;
    const role = classified.find((c) => c.kind === 'role')?.e || cleanEmail(r.email_osm);

    return {
      ...r,
      owner_name: owner.name,
      owner_title: owner.title,
      people: owner.others,
      emails_all: emails,
      email_personal: personal,
      email_generic: generic,
      email_role: role,
    };
  });

// --- MX verification (catches dead domains, the #1 source of hard bounces) ---
// NOTE: this is MX-only. We deliberately do NOT do SMTP RCPT probing — it is what
// gets your IP blocklisted, and mailbox-level checks are unreliable on modern
// catch-all providers anyway.
const domains = [...new Set(reachable.map((r) => r.domain))];
console.log(`MX-verifying ${domains.length} domains...`);

const mxOk = new Map();
let n = 0;
async function mxWorker(list) {
  for (const d of list) {
    try {
      const mx = await resolveMx(d);
      mxOk.set(d, mx.length > 0);
    } catch { mxOk.set(d, false); }
    if (++n % 100 === 0) console.log(`  ${n}/${domains.length}`);
  }
}
const chunks = Array.from({ length: 20 }, (_, i) => domains.filter((_, j) => j % 20 === i));
await Promise.all(chunks.map(mxWorker));

console.log(`  MX valid: ${[...mxOk.values()].filter(Boolean).length}/${domains.length}\n`);

// --- score against ICP ---
function score(r) {
  let s = 0;
  const why = [];

  s += Math.min(r.agency_score, 8) * 3;
  if (r.agency_score >= 4) why.push('strong-agency-signals');

  if (r.owner_name) { s += 15; why.push('owner-identified'); }
  if (/founder|owner|ceo/i.test(r.owner_title || '')) { s += 8; why.push('owner-is-decisionmaker'); }

  if (r.email_personal) { s += 20; why.push('personal-email'); }
  else if (r.email_generic) { s += 12; why.push('probable-personal-email'); }
  else if (r.email_role) { s += 8; why.push('role-email-only'); }

  const t = r.team_size_proxy;
  if (t != null && t >= ICP_MIN_TEAM && t <= ICP_MAX_TEAM) { s += 12; why.push('team-size-in-icp'); }
  else if (t != null && t > 40) { s -= 15; why.push('likely-too-big'); }

  if (r.city || r.state) { s += 5; why.push('has-location'); }
  if (r.phone) s += 3;

  s -= r.negative_signals.length * 20;
  if (r.negative_signals.length) why.push(`negative:${r.negative_signals.join('|')}`);

  if (!mxOk.get(r.domain)) { s -= 40; why.push('no-mx-will-bounce'); }

  return { s, why };
}

// Threshold of 1 (not 2) is what gets us to a 300-lead target. agency_score counts
// matched marketing keywords, so >=1 still means the site says "seo"/"ppc"/"branding"
// somewhere — but weak matches sink to the bottom via lead_score, which is the real
// quality signal. Raise with MIN_AGENCY_SCORE=2 for a smaller, higher-confidence list.
const MIN_AGENCY_SCORE = Number(process.env.MIN_AGENCY_SCORE) || 1;

const scored = reachable
  .map((r) => ({ ...r, ...score(r) }))
  .filter((r) => r.agency_score >= MIN_AGENCY_SCORE) // must look like an agency
  .filter((r) => r.negative_signals.length === 0) // drop newspapers/franchises/printers
  .filter((r) => mxOk.get(r.domain))            // drop guaranteed bounces
  .filter((r) => r.email_personal || r.email_generic || r.email_role) // must be contactable
  .sort((a, b) => b.s - a.s);

const top = scored.slice(0, TARGET);

// --- CSV ---
const esc = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const COLS = [
  ['agency_name', (r) => r.name],
  ['owner_name', (r) => r.owner_name],
  ['owner_title', (r) => r.owner_title],
  ['email', (r) => r.email_personal || r.email_generic || r.email_role],
  ['email_type', (r) => (r.email_personal ? 'personal' : r.email_generic ? 'probable-personal' : 'role')],
  ['domain', (r) => r.domain],
  ['website', (r) => r.website],
  ['city', (r) => r.city],
  ['state', (r) => r.state],
  ['phone', (r) => r.phone],
  ['team_size_est', (r) => r.team_size_proxy],
  ['lead_score', (r) => r.s],
  ['agency_signals', (r) => (r.agency_signals || []).join('; ')],
  ['other_contacts', (r) => (r.people || []).slice(1).join('; ')],
  ['all_emails', (r) => (r.emails_all || []).join('; ')],
  ['site_title', (r) => r.site_title],
  ['why_scored', (r) => (r.why || []).join('; ')],
  ['osm_id', (r) => r.osm_id],
];

const csv = [
  COLS.map(([h]) => h).join(','),
  ...top.map((r) => COLS.map(([, f]) => esc(f(r))).join(',')),
].join('\n');

writeFileSync('agency_leads.csv', csv, 'utf8');

console.log('=== STAGE 3 COMPLETE ===');
console.log(`Reachable sites:      ${reachable.length}`);
console.log(`Passed ICP filters:   ${scored.length}`);
console.log(`Exported (target ${TARGET}): ${top.length}`);
console.log(`  with owner name:    ${top.filter((r) => r.owner_name).length}`);
console.log(`  personal email:     ${top.filter((r) => r.email_personal).length}`);
console.log(`  probable-personal:  ${top.filter((r) => !r.email_personal && r.email_generic).length}`);
console.log(`  role email only:    ${top.filter((r) => !r.email_personal && !r.email_generic).length}`);
console.log(`  team size in ICP:   ${top.filter((r) => r.team_size_proxy >= ICP_MIN_TEAM && r.team_size_proxy <= ICP_MAX_TEAM).length}`);
console.log(`\nScore range: ${top.at(-1)?.s} .. ${top[0]?.s}`);
console.log(`\nWrote agency_leads.csv`);
