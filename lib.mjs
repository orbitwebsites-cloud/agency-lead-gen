// Shared cleaning + validation. Used by stage 2 (extraction) and stage 3 (re-derive).

// ---------- emails ----------

export function cleanEmail(raw) {
  if (!raw) return null;
  let e = String(raw).trim().toLowerCase();
  try { e = decodeURIComponent(e); } catch { /* leave as-is if malformed */ }
  e = e.replace(/^mailto:/, '').replace(/^[\s%20]+/, '').trim();
  e = e.split('?')[0]; // strip ?subject=... from mailto links
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(e)) return null;
  return e;
}

// Local-parts that are clearly a shared inbox, not a person.
const ROLE_LOCAL = new Set([
  'info','hello','contact','support','sales','admin','team','hi','help','office',
  'inquiries','inquiry','enquiries','marketing','press','careers','jobs','billing',
  'noreply','no-reply','donotreply','webmaster','postmaster','abuse','privacy','legal',
  'getnoticed','goto','ask','cc','bcc','mail','email','general','main','front desk',
  'frontdesk','reception','newbusiness','new-business','hey','yo','connect','letstalk',
  'lets-talk','work','projects','studio','agency','service','services','client','clients',
  'accounts','accounting','invoices','orders','booking','bookings','schedule','apply',
  'subscribe','newsletter','media','pr','social','hr','recruiting','training','events',
]);

/**
 * Classify an email as 'personal' | 'role' | 'generic'.
 * 'personal' requires positive evidence it maps to a human — ideally matching the
 * owner name we found. Absence of a role keyword is NOT evidence of a person.
 */
export function classifyEmail(email, ownerName) {
  const local = email.split('@')[0];
  const bare = local.replace(/[^a-z]/g, '');

  if (ROLE_LOCAL.has(local) || ROLE_LOCAL.has(bare)) return 'role';

  if (ownerName) {
    const [first, last] = ownerName.toLowerCase().split(/\s+/);
    const f = (first || '').replace(/[^a-z]/g, '');
    const l = (last || '').replace(/[^a-z]/g, '');
    if (f && (bare === f || bare === f + l || bare === l + f || bare === f[0] + l || bare === f + l[0])) {
      return 'personal';
    }
    if (f && local.startsWith(f) && f.length >= 3) return 'personal';
  }

  // Single short lowercase word that isn't a known role word — probably a first name,
  // but we have no corroboration, so don't overclaim.
  if (/^[a-z]{2,12}$/.test(local)) return 'generic';
  if (/^[a-z]+\.[a-z]+$/.test(local)) return 'personal'; // first.last is a strong shape

  return 'generic';
}

// ---------- person names ----------

// Capitalized words that show up constantly on agency sites and are not names.
const NOT_NAME_WORDS = new Set([
  'team','our','the','and','for','with','about','we','us','this','that','meet','contact',
  'read','view','learn','more','get','free','call','email','phone','join','start','book',
  'request','quote','blog','news','case','study','studies','social','search','content',
  'strategy','growth','agency','group','studio','solutions','partners','company','business',
  'small','local','best','top','new','now','today','full','real','time','data','google',
  'facebook','instagram','linkedin','twitter','copyright','all','rights','reserved','privacy',
  'policy','terms','site','map','skip','menu','close','open','next','prev','back','home',
  'marketing','media','design','designs','web','digital','brand','branding','creative','direct',
  'mail','review','reviews','schedule','consultant','consulting','materials','matter','light',
  'services','service','client','clients','project','projects','work','works','portfolio',
  'award','awards','winner','years','year','experience','expert','experts','specialist',
  'founded','founder','owner','president','director','manager','partner','principal','ceo',
  'lets','let','talk','hire','why','how','what','when','where','who','your','you','my','me',
  'inc','llc','ltd','co','corp','company','enterprises','holdings','ventures','labs','lab',
  'north','south','east','west','american','national','global','united','states','usa',
  'january','february','march','april','may','june','july','august','september','october',
  'november','december','monday','tuesday','wednesday','thursday','friday','saturday','sunday',
  'website','websites','page','pages','click','here','learn','discover','explore','see','find',
  'award','winning','trusted','proven','results','result','roi','leads','lead','sales','revenue',
  // English function words + boilerplate that leak in from body copy
  'thanks','thank','please','sincerely','regards','cheers','welcome','hey','hello','dear',
  'in','on','at','by','to','of','from','as','is','are','was','were','be','been','it','its',
  'information','technology','consent','cookie','cookies','accept','decline','submit','send',
  'introducing','featuring','presenting','including','above','below','before','after','during',
  'every','each','some','any','many','most','much','both','few','other','another','such','same',
  'first','second','third','last','next','previous','only','also','just','even','still','yet',
  'very','really','quite','rather','always','never','often','sometimes','usually','maybe',
  'over','under','through','between','among','across','around','within','without','into','onto',
  'plan','plans','pricing','price','package','packages','tier','tiers','free','trial','demo',
  'login','signup','sign','register','account','dashboard','profile','settings','support',
  'testimonial','testimonials','faq','faqs','question','questions','answer','answers',
]);

/**
 * Is this plausibly a real person's name?
 * Rejects business-vocabulary bigrams and anything echoing the company name —
 * the two failure modes that dominated the first pass.
 */
export function isPlausibleName(name, companyName = '') {
  if (!name) return false;
  const parts = name.trim().split(/\s+/);
  if (parts.length !== 2) return false;

  const [a, b] = parts.map((p) => p.toLowerCase().replace(/[^a-z'’-]/g, ''));
  if (a.length < 2 || b.length < 2) return false;
  if (a.length > 15 || b.length > 20) return false;

  // either token being business vocabulary kills it ("Team Matthew", "Direct Mail")
  if (NOT_NAME_WORDS.has(a) || NOT_NAME_WORDS.has(b)) return false;

  // name echoing the company name is the company, not a person ("Light Matter")
  const co = companyName.toLowerCase();
  if (co) {
    const coWords = new Set(co.split(/[^a-z]+/).filter(Boolean));
    if (coWords.has(a) || coWords.has(b)) return false;
  }

  // must look like Capitalized Capitalized in the original
  if (!/^[A-Z][a-z'’-]+\s+[A-Z][a-z'’-]+$/.test(name.trim())) return false;

  return true;
}

/** Pick the best valid person from a stage-2 `people` array of "Name (Title)" strings. */
export function pickOwner(peopleStrings, companyName) {
  const parsed = (peopleStrings || []).map((s) => {
    const m = String(s).match(/^(.*?)\s*\((.*)\)\s*$/);
    return m ? { name: m[1].trim(), title: m[2].trim() } : { name: String(s).trim(), title: '' };
  });
  const valid = parsed.filter((p) => isPlausibleName(p.name, companyName));
  if (!valid.length) return { name: null, title: null, others: [] };
  const rank = (p) => (/founder|owner|ceo|chief executive/i.test(p.title) ? 2 : /president|principal|managing/i.test(p.title) ? 1 : 0);
  valid.sort((x, y) => rank(y) - rank(x));
  return {
    name: valid[0].name,
    title: valid[0].title || null,
    others: valid.slice(1).map((p) => `${p.name} (${p.title})`),
  };
}
