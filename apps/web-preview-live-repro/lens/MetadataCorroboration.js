/**
 * v0.3.1 — Set / collector-number / language corroboration from targeted OCR text.
 *
 * Doctrine:
 *   - Metadata is corroborating evidence only. It never creates a candidate the visual top-K did
 *     not propose, never raises a visual score and never forces identity.
 *   - A printed number that clearly disagrees with the visual top's canonical record is a physical
 *     contradiction and blocks the lock (contradiction-first).
 *   - A bare local number (e.g. "199") is shared across hundreds of sets and is not printing-level
 *     support on its own. Printing-level support needs number + (printed total or set code).
 */

const SUPERSCRIPT = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9' };

export function normalizeNumberToken(value) {
  const s = String(value ?? '').replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, c => SUPERSCRIPT[c]).trim().toUpperCase();
  const m = s.match(/^([A-Z]{0,4})0*(\d{1,4})([A-Z]?)$/);
  if (!m) return s.replace(/\s+/g, '');
  return `${m[1]}${m[2]}${m[3]}`;
}

/**
 * Parse a collector line such as "199/165", "TG05/TG30", "GG01/GG70", "SVP 123", "MEW 199/165".
 * Returns nulls for anything not read confidently.
 */
export function parseCollectorText(text) {
  const t = String(text || '').replace(/[|]/g, '/').replace(/\s+/g, ' ');
  const full = t.match(/(?:^|[^A-Z0-9])([A-Z]{0,4})(\d{1,4})\s?\/\s?([A-Z]{0,4})(\d{1,4})(?![0-9])/i);
  let number = null, printedTotal = null;
  if (full) {
    number = normalizeNumberToken(`${full[1]}${full[2]}`);
    const total = Number(full[4]);
    // Subset numbering (TG05/TG30) has its own denominator; it is not the set's printed total.
    printedTotal = full[3] ? null : (Number.isFinite(total) && total > 0 ? total : null);
  }
  const setCode = (t.match(/(?:^|\s)([A-Z][A-Z0-9]{1,4})(?=\s+(?:[A-Z]{0,4})?\d{1,4}(?:\s?\/|\s|$))/) || [])[1] || null;
  if (!number) {
    const promo = t.match(/(?:^|\s)(SVP|SWSH|SMP|XYP|BWP|MEP)\s?(\d{1,4})(?=\s|$)/i);
    if (promo) number = normalizeNumberToken(`${promo[1]}${promo[2]}`);
  }
  return { number, printedTotal, setCode: setCode ? setCode.toUpperCase() : null };
}

function compare(observed, expected, equals = (a, b) => a === b) {
  if (observed == null || observed === '' || expected == null || expected === '') return 'UNKNOWN';
  return equals(observed, expected) ? 'MATCH' : 'MISMATCH';
}

/**
 * Compare parsed printed metadata against one candidate's canonical metadata.
 * `candidate`: { localId, printedTotal, setAbbreviation, lang }.
 */
export function corroborateCandidate(candidate, parsed, { observedLanguage = null } = {}) {
  // v0.3.6: some printings print a number different from the catalogue numbering (Classic
  // Collection reprints print the original "4/102", TCGdex numbers them 001–030). The printed form,
  // when known, is the physical truth.
  if (candidate?.printedNumber) {
    const [n, t] = String(candidate.printedNumber).split('/');
    candidate = { ...candidate, localId: n, printedTotal: t != null && t !== '' ? Number(t) : candidate.printedTotal };
  }
  const number = compare(parsed?.number, candidate?.localId != null ? normalizeNumberToken(candidate.localId) : null, (a, b) => normalizeNumberToken(a) === b);
  const printedTotal = compare(parsed?.printedTotal, candidate?.printedTotal ?? null, (a, b) => Number(a) === Number(b));
  const setCode = compare(parsed?.setCode, candidate?.setAbbreviation ? String(candidate.setAbbreviation).toUpperCase() : null);
  const language = compare(observedLanguage, candidate?.lang ?? null);

  const reasons = [];
  // Physical contradictions. A set-code token is too noisy to contradict on its own.
  const numberContradiction = number === 'MISMATCH' && parsed?.printedTotal != null;
  const totalContradiction = printedTotal === 'MISMATCH' && number !== 'UNKNOWN';
  const languageContradiction = language === 'MISMATCH';
  if (numberContradiction) reasons.push('printed_number_mismatch');
  if (totalContradiction) reasons.push('printed_total_mismatch');
  if (languageContradiction) reasons.push('printed_language_mismatch');
  const contradicts = reasons.length > 0;

  const printingSupport = !contradicts && number === 'MATCH' && (printedTotal === 'MATCH' || setCode === 'MATCH');
  const numberOnly = !contradicts && number === 'MATCH' && !printingSupport;
  return { number, printedTotal, setCode, language, printingSupport, numberOnly, contradicts, reasons };
}
