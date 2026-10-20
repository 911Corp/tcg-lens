/** Access to the app language (/i18n.js) from ES modules; French fallback (Node tests, no page). */
const interp = (s, v) => (v ? s.replace(/\{(\w+)\}/g, (m, k) => (v[k] ?? m)) : s);
export const t = (s, v) => (globalThis.I18N ? globalThis.I18N.t(s, v) : interp(s, v));
export const uiLang = () => globalThis.I18N?.lang || 'fr';
export const locale = () => (uiLang() === 'en' ? 'en-US' : 'fr-FR');
export function money(v, currency = 'EUR') {
  if (globalThis.I18N) return globalThis.I18N.money(v, currency);
  if (v == null || !Number.isFinite(Number(v))) return null;
  try { return new Intl.NumberFormat('fr-FR', { style: 'currency', currency, maximumFractionDigits: Number(v) >= 100 ? 0 : 2 }).format(Number(v)); } catch { return `${Number(v).toFixed(2)} ${currency}`; }
}
/** Preferred price market: 'us' (TCGplayer, USD) in English, 'eu' (Cardmarket, EUR) in French. */
export const market = () => (uiLang() === 'en' ? 'us' : 'eu');
