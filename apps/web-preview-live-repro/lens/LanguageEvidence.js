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

// One pattern per marker (PV/HP counted once). "resistance", "deck", "supporter", "pokemon" and "plus" are
// omitted: printed identically in FR and EN once OCR loses the accent. v0.4.3: rules-text vocabulary widened
// (calibrated on 1 036 degraded OCR reads of French and English cards, 400 of Japanese cards: tools/deep/lang-cues.md).
const CUES = {
  fr: [/\bpv(?=\s?\d|\b)/, /faiblesse/, /retraite/, /\bbase\b/, /\btalent\b/, /\bdresseur\b/, /\bniveau\b/, /\bstade\b/, /\bobjet\b/, /\bsoin/,
    /\bvotre\b|\bvos\b/, /\bavec\b/, /\bcartes?\b/, /\bpuis\b/, /\bdegats\b/, /\badversaire/, /\bpioche/, /\bmain\b/,
    /\battaque/, /\binflige/, /\bchaque\b/, /\benergie/, /\bdefausse/, /\bactif\b/, /\bbanc\b/, /\bpouvez\b/, /\blorsque\b/, /\bpendant\b/,
    /\bprochain/, /\bvous\b/, /\bcette\b/, /\bdans\b/, /\bles\b/, /\bdes\b/, /\baux\b/, /\bune\b/, /\best\b/, /\bsur\b/, /\bpeut\b/,
    /\bmelange/, /\bajoute/, /\bsupplementaire/, /\bpiece\b/, /\bjusqu/, /\bn'appliquez\b/, /\bevolue/, /\bregle\b/],
  en: [/\bhp(?=\s?\d|\b)/, /weakness/, /retreat/, /\bbasic\b/, /\bability\b/, /\btrainer\b/, /\bstage\b/, /\bitem\b/, /\bheal/,
    /\byour\b/, /\bwith\b/, /\bcards?\b/, /\bthen\b/, /\bdamage\b/, /\bopponent/, /\bdraw\b/, /\bhand\b/,
    /\battack\b/, /\bdoes\b/, /\beach\b/, /\benergy\b/, /\bdiscard/, /\bactive\b/, /\bbench/, /\bflip\b/, /\bcoin\b/, /\bheads\b/, /\btails\b/,
    /\bturn\b/, /\bnext\b/, /\bthis\b/, /\bthat\b/, /\bthe\b/, /\bfrom\b/, /\byou\b/, /\bmay\b/, /\bduring\b/, /\bdefending\b/, /\bput\b/,
    /\bmore\b/, /\buntil\b/, /\bshuffle/, /\bcounters?\b/, /\battached\b/, /\bevolves?\b/, /\bdon'?t apply\b/],
};
// Markers long enough never to come out of OCR noise: the only ones counted when the Latin reader is unsure
// (Japanese cards, glare), so that noise on a Japanese card is never read as French or English.
const LONG = {
  fr: CUES.fr.filter(re => /faiblesse|retraite|adversaire|degats|attaque|inflige|energie|defausse|pioche|supplementaire|lorsque|pendant|prochain/.test(re.source)),
  en: CUES.en.filter(re => /weakness|retreat|opponent|damage|attack|discard|energy|defending|attached|shuffle|during|counters/.test(re.source)),
};
// French-only spellings kept by the OCR: accented words (except Pokémon / Poké…) and elisions (l'…, d'…, n'…, qu'…).
const ACCENTED = /[a-z]*[éèêëàâçùûôî][a-zéèêëàâçùûôî]*/g;
const FR_ELISION = /(?:^|[^a-z])(?:l|d|n|qu|s|j|c)['’][a-zéèêàâ]/;
const EN_CONTRACTION = /[a-z]['’](?:s|t)\b/;
const JA_STRONG_MIN = 2;
const KANA = /[぀-ヿ]/g;              // hiragana + katakana: Japanese-only
const CJK = /[぀-ヿ一-鿿]/g;  // + kanji

/** Distinct printed markers of each Latin language in one read. */
export function latinCueScores(text, readable = true) {
  const raw = String(text || '').toLowerCase(), t = fold(raw);
  const scores = { fr: 0, en: 0 };
  for (const lang of ['fr', 'en']) scores[lang] = (readable ? CUES : LONG)[lang].filter(re => re.test(t)).length;
  if (readable) {
    const accented = new Set((raw.match(ACCENTED) || []).filter(w => w.length >= 3 && !/^pok/.test(w)));
    scores.fr += Math.min(2, accented.size) + (FR_ELISION.test(raw) ? 1 : 0);
    scores.en += EN_CONTRACTION.test(raw) && !FR_ELISION.test(raw) ? 1 : 0;
  }
  return scores;
}

const JA_CHAR = /[぀-ヿ一-鿿]/g;
const jaChars = w => (String(w).match(JA_CHAR) || []).filter(ch => ch !== 'ー').length;
/**
 * P(Japanese card) from the two readers (logistic model, tools/deep/lang-cues.md): Japanese characters in
 * confident multi-character words, share of Japanese characters, confident Latin words.
 */
export function japaneseScriptProbability(script, latinText = '') {
  const W = script?.jaWords || [];
  const jt = String(script?.jaText || '').replace(/ー/g, '');
  const total = Math.max(1, jt.replace(/\s/g, '').length);
  const multi = W.filter(([w, c]) => c >= 70 && jaChars(w) >= 2).length;
  const maxConf = Math.max(0, ...W.filter(([w]) => jaChars(w) >= 2).map(([, c]) => c)) / 100;
  const jaConfs = W.filter(([w]) => jaChars(w) > 0).map(([, c]) => c);
  const meanConf = jaConfs.length ? jaConfs.reduce((a, b) => a + b, 0) / jaConfs.length / 100 : 0;
  const kana = (jt.match(KANA) || []).length, ratio = (jt.match(CJK) || []).length / total;
  const latinWords = (String(latinText).match(/[A-Za-z]{3,}/g) || []).length;
  const z = -3.053 + 0.083 * (script?.jaStrong ?? 0) + 1.226 * multi + 1.485 * maxConf - 0.028 * kana + 4.699 * ratio
    - 2.072 * (script?.latinStrong ?? 0) + 0.014 * latinWords + 0.739 * meanConf;
  return 1 / (1 + Math.exp(-z));
}

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
  const latinReadable = latinStrong >= 2;
  Object.assign(scores, latinCueScores(text, latinReadable));

  const jaText = `${script?.jaText || ''} ${text || ''}`.replace(/ー/g, '');
  const kana = (jaText.match(KANA) || []).length, cjk = (jaText.match(CJK) || []).length;
  // v0.4.3: a Japanese card never prints the Latin (FR/EN) name of the Pokémon. When the Latin reader finds it,
  // kana from the Japanese reader are noise (holo foil, sleeve glare), never script evidence.
  const latinNames = [...(candidate.languages || []).filter(l => l !== 'ja').map(l => fold(candidate.byLang?.[l]?.name)), ...(candidate.latinNames || []).map(fold)]
    .filter(n => n.length >= 4);
  const nameRead = latinNames.filter(n => t.includes(n));
  const latinNameRead = nameRead.length > 0;
  // A name of 6+ letters read exactly cannot come out of noise: it proves Latin script even on an unreadable pass.
  const latinNameProof = latinNameRead && (latinReadable || nameRead.some(n => n.length >= 6));
  // Japanese script evidence. Confirming a family printed in Japanese keeps the permissive rule; against a
  // family printed only in Latin languages (FR/EN), the Japanese reader's hallucinations on holo foil would
  // otherwise contradict the right card (10 % of clean and 21 % of holo Latin reads passed the permissive rule),
  // so the calibrated script score must reach P ≥ 0.98 (0 / 678 Latin reads, tools/deep/lang-cues.md).
  const permissive = script ? latinStrong <= 2 && kana >= 4 && cjk >= 5 && (script.jaStrong ?? 0) >= JA_STRONG_MIN : kana >= 2 && cjk >= 3;
  const latinOnlyFamily = candidate.strictScript === true || ((candidate.languages || []).length > 0 && !candidate.languages.includes('ja'));
  const jaProof = permissive && (!latinOnlyFamily || !script || japaneseScriptProbability(script, text) >= 0.98);
  if (!latinNameRead && jaProof) scores.ja += 3;

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
  // One read names a language only when its markers clearly dominate: ≥ 2 and none of another language, or
  // ≥ 3 and at least three times the other language's (OCR noise can produce one stray marker).
  const lang = (best[1] >= 2 && second[1] === 0) || (best[1] >= 3 && best[1] >= 3 * second[1]) ? best[0] : null;
  // A read with many independent markers of one language is strong (counts as two reads).
  const strong = Boolean(lang && ((best[1] >= 4 && second[1] === 0) || (best[1] >= 6 && second[1] <= 1)));
  // Script of the card (Latin vs Japanese), proven even when FR vs EN is not: a Latin language read, or the
  // Latin name of the Pokémon read by the Latin reader (a Japanese card prints it in katakana).
  const cardScript = lang === 'ja' ? 'ja' : (lang || (latinNameProof && scores.ja === 0)) ? 'latin' : null;
  return { lang, scores, nameHit, strong, script: cardScript };
}

export class LanguageConsensus {
  constructor({ requiredReads = 2, singleLanguageReads = 1 } = {}) {
    this.requiredReads = Math.max(2, requiredReads);
    this.singleLanguageReads = Math.max(0, singleLanguageReads);
    this.reset();
  }

  reset() { this.reads = new Map(); this.scripts = new Map(); } // familyId -> Map(lang -> count), familyId -> { latin, ja }

  /** @param {boolean} [strong] a read with ≥4 distinct markers of one language and none of another counts twice */
  observe(familyId, lang, languages = null, strong = false, script = null) {
    if (familyId && script) {
      const sc = this.scripts.get(familyId) || { latin: 0, ja: 0 };
      sc[script] += strong ? 2 : 1; this.scripts.set(familyId, sc);
    }
    if (familyId && lang) {
      const m = this.reads.get(familyId) || new Map();
      m.set(lang, (m.get(lang) || 0) + (strong ? 2 : 1));
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

  /** Any read of a language the family does not exist in (even a single one). */
  outside(familyId, languages) {
    if (!languages?.length) return false;
    for (const [lang] of this.reads.get(familyId) || []) if (!languages.includes(lang)) return true;
    return false;
  }

  /** Proven language for a family, or null (unresolved or contradicted). */
  resolved(familyId, languages = null) {
    if (languages?.length && this.contradicted(familyId, languages)) return null;
    if (languages && languages.length === 1) {
      const agreeing = this.reads.get(familyId)?.get(languages[0]) || 0;
      return agreeing >= this.singleLanguageReads ? languages[0] : null;
    }
    const m = this.reads.get(familyId); if (!m) return null;
    // v0.4.3: the leading language must have the required reads and dominate (≥ 3× the others): one stray
    // misread no longer blocks a card read correctly many times, but two disagreeing reads still do.
    const [[lang, count], second = [null, 0]] = [...m.entries()].sort((a, b) => b[1] - a[1]);
    if (languages && !languages.includes(lang)) return null;
    return count >= this.requiredReads && (second[1] === 0 || count >= 3 * second[1]) ? lang : null;
  }

  /** v0.4.3: 'latin' | 'ja' | null — the card's script, with the same two-read dominance rule as languages. */
  scriptResolved(familyId) {
    const sc = this.scripts.get(familyId); if (!sc) return null;
    if (sc.latin >= this.requiredReads && sc.latin >= 3 * sc.ja) return 'latin';
    if (sc.ja >= this.requiredReads && sc.ja >= 3 * sc.latin) return 'ja';
    return null;
  }

  readsFor(familyId) { return [...(this.reads.get(familyId)?.values() || [])].reduce((a, b) => a + b, 0); }
}
