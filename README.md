# Agency Lead Gen

Builds a scored list of **US marketing agency owners** from open data — no paid tools, no scraping of sites that forbid it.

Target ICP: US-based, 2–20 people, full-service digital / SEO / paid ads.

## Why this approach

The obvious sources (Clutch, UpCity, GoodFirms, DesignRush, The Manifest) **all return HTTP 403** to any programmatic request — they sit behind Cloudflare bot detection, and their terms prohibit scraping. Defeating that is both against their ToS and a great way to get your IP flagged right when you're trying to build sending reputation.

So this pulls from **OpenStreetMap** instead, via the Overpass API:

- Genuinely open data (ODbL license), explicitly built for programmatic access
- No bot detection, no ToS problem, no API key, free
- ~3,000 US businesses tagged as advertising/marketing/design agencies

OSM gives you the *company*. The *owner* comes from crawling each agency's own public website — which for a 2–20 person shop almost always names the founder on `/about` or `/team`.

## Pipeline

```bash
npm run harvest   # 1. OSM -> agencies_raw.json     (~3k elements, ~1.3k with websites)
npm run enrich    # 2. crawl each site -> agencies_enriched.json  (owner, emails, signals)
npm run export    # 3. MX-verify + score + filter -> agency_leads.csv
```

Or `npm run all`. Stage 2 checkpoints every 25 records and resumes if interrupted.

### Stage 1 — `1_harvest_osm.mjs`

Queries Overpass for `office=advertising_agency|marketing|graphic_design|web_design`, plus `newspaper`/`publisher` (which sell ad services and sometimes tag this way). Deduped by domain, drops anything without a website.

Runs each tag selector as a **separate query** — one combined query with name-regex over the whole US times out with a 504.

### Stage 2 — `2_enrich.mjs`

For each domain, fetches up to 4 of: `/`, `/about`, `/about-us`, `/team`, `/our-team`, `/contact`, `/contact-us`, `/leadership`. Then:

- **Owner name** — from schema.org JSON-LD (`founder`/`employee`) first, then name-within-60-chars-of-a-leadership-title text proximity
- **Emails** — `mailto:` links + body text, filtered to the agency's own domain, split into personal vs role (`info@`, `hello@`…)
- **Agency confirmation** — keyword match ("seo", "ppc", "paid media", "brand strategy"…) so a 3D-printing company tagged wrong in OSM gets dropped
- **Negative signals** — newspaper/franchise/print/public-company markers
- **Team size proxy** — distinct person-names on the team page

Concurrency 14, 12s timeout, capped at 4 pages per site so small business hosting doesn't get hammered.

### Stage 3 — `3_verify_export.mjs`

MX-verifies every domain, scores against the ICP, drops anything that fails, exports top N (default 300) to CSV.

**MX-only by design.** No SMTP RCPT probing — that's what gets you blocklisted, and it's unreliable against catch-all providers anyway. MX checks catch dead domains, which are the main source of hard bounces.

Scoring: personal email `+20`, owner identified `+15`, team size in ICP `+12`, decision-maker title `+8`, agency signals `+3` each, has location `+5`; too big `-15`, negative signal `-20` each, no MX `-40`.

```bash
node 3_verify_export.mjs 500   # export 500 instead of 300
```

## Output

`agency_leads.csv` — `agency_name`, `owner_name`, `owner_title`, `email`, `email_type`, `domain`, `website`, `city`, `state`, `phone`, `team_size_est`, `lead_score`, `agency_signals`, `other_contacts`, `all_emails`, `site_title`, `why_scored`, `osm_id`.

Sorted by score. `why_scored` explains each one so you can sanity-check the ranking rather than trusting it blind.

## Data handling

Output files are **gitignored** — they contain real people's names, emails and phone numbers. Don't commit them, and don't push this repo public with data in it. Regenerate by running the pipeline.

## Before you send

Cold email to US business addresses is legal under CAN-SPAM, but it has requirements — they're cheap to meet and expensive to ignore:

- Accurate `From` / `Reply-To` and a non-deceptive subject line
- A working opt-out, honored within 10 business days
- A real physical postal address in the footer
- Don't send from your primary domain — buy a separate one, warm it up, keep volume low at first

`lead_score` is a heuristic, not truth. Spot-check the top 20 by hand before you send to 300.
