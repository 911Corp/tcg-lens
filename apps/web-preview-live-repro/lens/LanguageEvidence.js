/**
 * Language of the physical card, proven from printed text — never guessed.
 *
 * Every OCR pass yields at most one language read among FR / EN / JA:
 *   - Japanese: the Latin reader recognises (almost) no word with confidence while the Japanese
 *     reader finds kana with confidence (script evidence), or the Japanese printed name is found;
 *   - French / English: printed markers (PV/HP, Faiblesse/Weakness…), rules-text words and a
 *     language-specific printed name.
 *
 * Consensus per printing family (TCGdex id):
 *   - family present in several languages (FR/EN share artwork): two agreeing reads and no
 *     disagreeing read are required;
 *   - family present in one language: in automatic scan mode one agreeing read is required (a
 *     Japanese card can match an English-only printing whose Japanese twin is missing from the
 *     catalogue); when the user fixed the scan language, none;
 *   - in every case, two reads of a language the family does not exist in contradict it and block
 *     the lock.
 */
const fold = s => String(s || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

export const CARD_LANGS = Object.freeze(['fr', 'en', 'ja']);

// One pattern per marker (PV/HP counted once). "resistance" is omitted: identical in FR/EN once
// OCR loses the accent.
const CUES = {
  fr: [/\bpv(?=\s?\d|\b)/, /faiblesse/, /retraite/, /\bde base\b/, /\btalent\b/, /\bdresseur\b/, /\bniveau\b/, /\bstade\b/, /\bobjet\b/, /\bsupporter\b/, /\bsoin/,
    /\bvotre\b|\bvos\b/, /\bavec\b/, /\bcartes?\b/, /\bpuis\b/, /\bdegats\b/, /\badversaire\b/, /\bpioche/, /\bmain\b/],
  en: [/\bhp(?=\s?\d|\b)/, /weakness/, /retreat/, /\bbasic\b/, /\bability\b/, /\btrainer\b/, /\bstage\b/, /\bitem\b/, /\bheal/,
    /\byour\b/, /\bwith\b/, /\bcards?\b/, /\bthen\b/, /\bdamage\b/, /\bopponent/, /\bdraw\b/, /\bhand\b/],
};
const KANA = /[぀-ヿ]/g;              // hiragana + katakana: Japanese-only
const CJK = /[぀-ヿ一-鿿]/g;  // + kanji

/**
 * @param {string} text Latin-reader OCR text of the card zones
 * @param {{ languages?: string[], byLang?: Record<string, {name: string}> }} candidate visual top family
 * @param {{ latinConf: number, jaConf: number, jaText: string } | null} script parallel Japanese read
 * @returns {{ lang: string|null, scores: Record<string, number>, nameHit: string|null }}
 */
export function detectCardLanguage(text, candidate = {}, script = null) {
  const t = fold(text);
  const scores = { fr: 0, en: 0, ja: 0 };
  // Script evidence (calibrated on camera reads): on a Latin card the Latin model recognises many
  // words with high confidence (15+ per pass); on a Japanese card almost none. The Japanese model
  // hallucinates kana on Latin cards, so kana alone are never enough.
  const latinStrong = script ? script.latinStrong ?? 99 : 99;
  const latinReadable = latinStrong >= 3;
  if (latinReadable) for (const lang of ['fr', 'en']) scores[lang] += CUES[lang].filter(re => re.test(t)).length;

  const jaText = `${script?.jaText || ''} ${text || ''}`.replace(/ー/g, '');
  const kana = (jaText.match(KANA) || []).length, cjk = (jaText.match(CJK) || []).length;
  if (script ? latinStrong <= 2 && kana >= 4 && cjk >= 5 && (script.jaStrong ?? 0) >= 2 : kana >= 2 && cjk >= 3) scores.ja += 3;

  // A printed name that differs between languages is the strongest cue.
  let nameHit = null;
  const languages = candidate.languages?.length ? candidate.languages : [];
  const names = Object.fromEntries(languages.map(l => [l, fold(candidate.byLang?.[l]?.name)]));
  const haystack = `${t} ${fold(script?.jaText)}`;
  for (const lang of languages) {
    const n = names[lang];
    if (!n || n.length < (lang === 'ja' ? 2 : 4) || (lang !== 'ja' && !latinReadable)) continue;
    const sharedWithOther = languages.some(o => o !== lang && names[o] === n);
    if (!sharedWithOther && haystack.includes(n)) { scores[lang] += 2; nameHit = lang; }
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [best, second] = ranked;
  const lang = best[1] >= 1 && best[1] > second[1] ? best[0] : null;
  return { lang, scores, nameHit };
}

export class LanguageConsensus {
  constructor({ requiredReads = 2, singleLanguageReads = 1 } = {}) {
    this.requiredReads = Math.max(2, requiredReads);
    this.singleLanguageReads = Math.max(0, singleLanguageReads);
    this.reset();
  }

  reset() { this.reads = new Map(); } // familyId -> Map(lang -> count)

  observe(familyId, lang, languages = null) {
    if (familyId && lang) {
      const m = this.reads.get(familyId) || new Map();
      m.set(lang, (m.get(lang) || 0) + 1);
      this.reads.set(familyId, m);
    }
    return this.resolved(familyId, languages);
  }

  /** A language the family does not exist in, read at least twice. */
  contradicted(familyId, languages) {
    if (!languages?.length) return null;
    for (const [lang, n] of this.reads.get(familyId) || []) if (!languages.includes(lang) && n >= this.requiredReads) return lang;
    return null;
  }

  /** Proven language for a family, or null (unresolved or contradicted). */
  resolved(familyId, languages = null) {
    if (languages?.length && this.contradicted(familyId, languages)) return null;
    if (languages && languages.length === 1) {
      const agreeing = this.reads.get(familyId)?.get(languages[0]) || 0;
      return agreeing >= this.singleLanguageReads ? languages[0] : null;
    }
    const m = this.reads.get(familyId); if (!m) return null;
    const entries = [...m.entries()];
    if (entries.length !== 1) return null; // any disagreeing read keeps it unresolved
    const [lang, count] = entries[0];
    if (languages && !languages.includes(lang)) return null;
    return count >= this.requiredReads ? lang : null;
  }

  readsFor(familyId) { return [...(this.reads.get(familyId)?.values() || [])].reduce((a, b) => a + b, 0); }
}
