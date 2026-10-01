/**
 * Where a job actually is, which is the question job boards answer worst.
 *
 * Two separate questions, deliberately kept apart. Is the role remote, and is
 * it in the United States? A posting can be remote and in Germany, or in the
 * US and require an office five days a week, and the earlier version of this
 * screen let both through by testing only for the absence of onsite language.
 * Absence of evidence was the bug: a posting whose location reads "San
 * Francisco" and which never says the word remote is an office job, and
 * silence has to count against it rather than for it.
 */

/** Both spellings of every state, plus DC, matched as whole words. */
const US_STATES = [
  ['alabama','al'],['alaska','ak'],['arizona','az'],['arkansas','ar'],['california','ca'],
  ['colorado','co'],['connecticut','ct'],['delaware','de'],['florida','fl'],['georgia','ga'],
  ['hawaii','hi'],['idaho','id'],['illinois','il'],['indiana','in'],['iowa','ia'],
  ['kansas','ks'],['kentucky','ky'],['louisiana','la'],['maine','me'],['maryland','md'],
  ['massachusetts','ma'],['michigan','mi'],['minnesota','mn'],['mississippi','ms'],['missouri','mo'],
  ['montana','mt'],['nebraska','ne'],['nevada','nv'],['new hampshire','nh'],['new jersey','nj'],
  ['new mexico','nm'],['new york','ny'],['north carolina','nc'],['north dakota','nd'],['ohio','oh'],
  ['oklahoma','ok'],['oregon','or'],['pennsylvania','pa'],['rhode island','ri'],['south carolina','sc'],
  ['south dakota','sd'],['tennessee','tn'],['texas','tx'],['utah','ut'],['vermont','vt'],
  ['virginia','va'],['washington','wa'],['west virginia','wv'],['wisconsin','wi'],['wyoming','wy'],
  ['district of columbia','dc'],
] as const;

/**
 * Abbreviations are only trusted in a location field, never in prose, because
 * "OR", "IN", "ME" and "HI" are ordinary English words. Full names are safe
 * anywhere.
 */
const STATE_NAMES = new RegExp(`\\b(${US_STATES.map(([full]) => full).join('|')})\\b`, 'i');
const STATE_CODES = new RegExp(`(?:^|[,\\s(|])(${US_STATES.map(([, ab]) => ab.toUpperCase()).join('|')})(?=$|[,\\s)|])`);

const US_NAMED = /\b(united states|u\.s\.a?\.?|usa|us[- ]remote|remote[- ]us\b|anywhere in the (?:us|united states)|nationwide|coast to coast)\b/i;

/** Countries and regions that settle the question the other way. */
const NON_US = /\b(united kingdom|england|scotland|wales|ireland|germany|france|spain|portugal|netherlands|belgium|poland|czech|romania|bulgaria|italy|greece|sweden|norway|denmark|finland|iceland|switzerland|austria|hungary|croatia|serbia|ukraine|turkey|israel|uae|dubai|saudi|egypt|nigeria|kenya|south africa|india|pakistan|bangladesh|sri lanka|china|hong kong|taiwan|japan|korea|singapore|malaysia|thailand|vietnam|philippines|indonesia|australia|new zealand|canada|mexico|brazil|argentina|chile|colombia|peru|costa rica|emea|apac|latam|anz|europe|asia)\b/i;

const NON_US_CITY = /\b(london|manchester|edinburgh|dublin|berlin|munich|hamburg|frankfurt|paris|lyon|madrid|barcelona|lisbon|amsterdam|rotterdam|brussels|warsaw|krakow|prague|bucharest|milan|rome|athens|stockholm|oslo|copenhagen|helsinki|zurich|geneva|vienna|budapest|kyiv|istanbul|tel aviv|bangalore|bengaluru|hyderabad|mumbai|delhi|gurgaon|pune|chennai|beijing|shanghai|shenzhen|tokyo|osaka|seoul|taipei|sydney|melbourne|brisbane|auckland|toronto|vancouver|montreal|ottawa|calgary|mexico city|guadalajara|sao paulo|buenos aires|bogota|santiago|lima)\b/i;

/** Language that means the role itself is remote, not that remote work exists. */
const REMOTE = /\b(remote|work from home|wfh|fully distributed|distributed team|work from anywhere|anywhere in the|home[- ]based|telecommut)/i;

/** Remote in name only: an office attendance requirement stated outright. */
export const OFFICE_REQUIRED = /\b(hybrid|on-?site|in-?office|in the office|in-?person)\b[^.\n]{0,60}\b(\d|one|two|three|four|five|daily|weekly|each week|per week|a week|required|expectation|minimum)\b|\b(\d|one|two|three|four|five)\+?\s*days?\s*(?:a|per)\s*week\b[^.\n]{0,40}\b(office|on-?site|in-?person)\b|\bmust (?:be able to |be willing to )?(?:work|commute|report) (?:from |to )?(?:the )?(?:office|on-?site)\b|\brelocat(?:e|ion) (?:to|is) (?:required|expected)\b|\bthis is a hybrid (?:role|position)\b/i;

export type Place = {
  /** The posting states the role is remote. */
  remote: boolean;
  /** The posting places the role in the United States. */
  us: boolean;
  /** The posting places the role somewhere other than the United States. */
  elsewhere: boolean;
  /** Remote, but with office days demanded anyway. */
  officeDays: boolean;
};

export function readPlace(location: string | null, description: string): Place {
  const where = location ?? '';
  // Only the opening of a description is trusted for place: the boilerplate at
  // the bottom of a posting names every office the company has.
  const head = description.slice(0, 3_000);

  // The location field is the authority whenever the employer filled one in.
  // Descriptions say "remote" constantly — in a benefits list, in a sentence
  // about the company being remote-friendly, in a line about a remote team the
  // role supports — and consulting them let office-only roles in Figma's and
  // Asana's New York offices through. Only when there is no location at all is
  // the description asked.
  const structured = /Remote:\s*yes/i.test(description) || /Workplace type:\s*Remote/i.test(description);
  const remote = structured || (where ? REMOTE.test(where) : REMOTE.test(head));

  const us = US_NAMED.test(where) || STATE_NAMES.test(where) || STATE_CODES.test(where)
    || US_NAMED.test(head) || (!where && STATE_NAMES.test(head));

  const elsewhere = NON_US.test(where) || NON_US_CITY.test(where);

  return { remote, us, elsewhere, officeDays: OFFICE_REQUIRED.test(head) };
}
