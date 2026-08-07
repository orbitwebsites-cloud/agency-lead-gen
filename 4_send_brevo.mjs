// Stage 4: Send the outreach sequence via Brevo.
//
// DRY RUN BY DEFAULT. Nothing is transmitted unless you pass --send.
//
//   node 4_send_brevo.mjs                  # preview, sends nothing
//   node 4_send_brevo.mjs --limit 20       # preview first 20
//   node 4_send_brevo.mjs --send --limit 20  # actually send 20
//
// Every send is appended to sent_log.jsonl, which doubles as the suppression
// list — re-running never mails the same address twice.

import { readFileSync, appendFileSync, existsSync } from 'node:fs';

const args = process.argv.slice(2);
const SEND = args.includes('--send');
const LIMIT = Number(args[args.indexOf('--limit') + 1]) || (SEND ? 20 : 5);
const DAILY_CAP = 30;

const SENDER = { name: 'Alex', email: 'alex@orbitboyzz.me' };
const REPLY_TO = { email: 'alex@orbitboyzz.me' };
const POSTAL = 'OrbitBoyzz — 33 Florence Ave, Ewing, NJ 08618';

const key = readFileSync('D:/StreamAPP/sd.txt', 'utf8').match(/Brevo_Key\s*=\s*(\S+)/i)?.[1];
if (!key) { console.error('No Brevo key found in sd.txt'); process.exit(1); }

// ---------- variants ----------
const VARIANTS = {
  A: {
    subject: (r) => `quick q for ${r.agency_name}`,
    body: (r) => `Hey ${r.first_name},

${r.agency_name} came up while I was researching ${r.city || 'local'} agencies.

I'm building an ops platform for small agencies — project management, client campaign dashboards, and AI agents that draft proposals and briefs. White-labelled, so it carries your brand.

I'm talking to owners first so I build what people actually want instead of guessing.

Worth 15 minutes to tell me what would make it useful for you? Early access is free for anyone who helps shape it.

— Alex`,
  },
  B: {
    subject: () => `how do you handle client reporting?`,
    body: (r) => `Hey ${r.first_name},

You came up in my research on ${r.city || 'local'} agencies, so figured I'd just ask.

Most 5-20 person shops I talk to run client work across four or five tools that don't talk to each other — PM in one place, reporting in another, proposals rewritten from scratch every time.

I'm building one hub for that, with AI agents handling the repetitive drafting. Collecting requirements from owners before I lock the roadmap.

Real problem at ${r.agency_name}, or have you already solved it? Genuinely useful either way.

— Alex`,
  },
  C: {
    subject: () => `15% recurring, if this is interesting`,
    body: (r) => `Hey ${r.first_name},

${r.agency_name} showed up in my research on ${r.city || 'local'} agencies.

I'm building an ops platform for agencies — internal tools plus AI agents, white-labelled as yours.

The part I think actually matters: refer a client to us for the website and domain monitoring side, and you keep 15% of what they spend, ongoing. Your ops stack ends up paying for itself.

Shaping the roadmap with owners right now. Want to be one of them?

— Alex`,
  },
  D: {
    subject: () => `yo — got 2 minutes?`,
    body: (r) => `Hey ${r.first_name},

You came up in my research on ${r.city || 'local'} agencies.

Quick version: I'm building agency ops software — projects, client dashboards, AI agents for the proposals and briefs nobody wants to write.

I'd rather build what owners actually want than guess. What wastes the most time at ${r.agency_name} right now?

One sentence back is plenty.

— Alex`,
  },
  E: {
    subject: () => `building something for agencies — worth 15 min?`,
    body: (r) => `Hey ${r.first_name},

Came across ${r.agency_name} researching ${r.city || 'local'} agencies.

I'm building an ops platform for small agencies: one place for projects, client campaign dashboards, and AI agents that draft the proposals and briefs nobody wants to write. White-label, so it's your brand and not mine.

Doing this the boring way — talking to owners before locking the roadmap.

15 minutes, and you get early access free if you help shape it.

— Alex`,
  },
};

// ---------- CSV ----------
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const head = rows.shift();
  return rows.filter((r) => r.length === head.length).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

const firstName = (owner, fallbackDomain) => {
  const n = (owner || '').trim().split(/\s+/)[0];
  return n && /^[A-Za-z][a-z'’-]+$/.test(n) ? n : 'there';
};

// ---------- unsubscribe ----------
// CAN-SPAM requires a working opt-out. This points at a mailto: handler, which
// is the honest minimum when there's no hosted unsubscribe endpoint yet.
// Replace with a real URL once one exists.
const unsubMailto = (email) =>
  `mailto:alex@orbitboyzz.me?subject=unsubscribe%20${encodeURIComponent(email)}`;

const footer = (email) => `

---
${POSTAL}
Not relevant? Reply "unsubscribe" and I won't email you again.`;

// ---------- load + suppress ----------
const leads = parseCsv(readFileSync('agency_leads.csv', 'utf8'));

const sentBefore = new Set();
if (existsSync('sent_log.jsonl')) {
  for (const line of readFileSync('sent_log.jsonl', 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { sentBefore.add(JSON.parse(line).email.toLowerCase()); } catch {}
  }
}

// Personal and probable-personal first — those reach a human.
const rank = { personal: 0, 'probable-personal': 1, role: 2 };
const queue = leads
  .filter((r) => r.email && !sentBefore.has(r.email.toLowerCase()))
  .sort((a, b) => (rank[a.email_type] ?? 3) - (rank[b.email_type] ?? 3) || Number(b.lead_score) - Number(a.lead_score))
  .slice(0, Math.min(LIMIT, DAILY_CAP));

const keys = Object.keys(VARIANTS);

console.log(SEND ? '*** LIVE SEND ***' : '--- DRY RUN (pass --send to transmit) ---');
console.log(`queued: ${queue.length}   already sent: ${sentBefore.size}   daily cap: ${DAILY_CAP}\n`);

let ok = 0, fail = 0;

for (const [i, r] of queue.entries()) {
  const vk = keys[i % keys.length]; // round-robin A/B/C/D/E
  const v = VARIANTS[vk];
  const ctx = { ...r, first_name: firstName(r.owner_name) };
  const subject = v.subject(ctx);
  const body = v.body(ctx) + footer(r.email);

  if (!SEND) {
    console.log(`[${vk}] ${r.email}  (${r.email_type}, score ${r.lead_score})`);
    console.log(`     subj: ${subject}`);
    console.log(`     to:   ${ctx.first_name} @ ${r.agency_name}`);
    console.log(`     words: ${body.split(/\s+/).length}\n`);
    continue;
  }

  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': key, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: SENDER,
        replyTo: REPLY_TO,
        to: [{ email: r.email, name: r.owner_name || r.agency_name }],
        subject,
        textContent: body,
        headers: { 'List-Unsubscribe': `<${unsubMailto(r.email)}>` },
      }),
    });
    const out = await res.text();
    if (res.ok) {
      ok++;
      appendFileSync('sent_log.jsonl', JSON.stringify({ email: r.email, variant: vk, subject, agency: r.agency_name, status: res.status }) + '\n');
      console.log(`  sent [${vk}] ${r.email}`);
    } else {
      fail++;
      console.log(`  FAIL ${res.status} ${r.email}: ${out.slice(0, 200)}`);
      if (res.status === 401 || res.status === 402 || res.status === 403) {
        console.log('\n  Auth/credit/permission error — stopping rather than burning the rest.');
        break;
      }
    }
  } catch (e) {
    fail++;
    console.log(`  ERROR ${r.email}: ${e.message}`);
  }

  // ~45s spacing. Bursts are the clearest automation signal to filters.
  if (i < queue.length - 1) await new Promise((s) => setTimeout(s, 45000));
}

if (SEND) console.log(`\nsent ${ok}, failed ${fail}. Logged to sent_log.jsonl`);
else console.log('Dry run only. Nothing was transmitted.');
