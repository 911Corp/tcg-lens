export type BarcodeScheme = 'UPC_A' | 'EAN_13' | 'JAN_13' | 'GTIN_14';

export interface NormalizedBarcode {
  raw: string;
  scheme: BarcodeScheme;
  gtin14: string;
  checksumValid: boolean;
}

export function normalizeBarcode(raw: string): NormalizedBarcode | null {
  const digits = raw.replace(/\D/g, '');
  let scheme: BarcodeScheme;
  if (digits.length === 12) scheme = 'UPC_A';
  else if (digits.length === 13) scheme = 'EAN_13';
  else if (digits.length === 14) scheme = 'GTIN_14';
  else return null;
  // JAN uses the EAN-13 structure; callers may relabel it from source/region metadata.
  const gtin14 = digits.padStart(14, '0');
  return { raw, scheme, gtin14, checksumValid: validateGtin(digits) };
}

export function validateGtin(digits: string): boolean {
  if (!/^\d{8}$|^\d{12}$|^\d{13}$|^\d{14}$/.test(digits)) return false;
  const body = digits.slice(0, -1);
  const expected = Number(digits.at(-1));
  let sum = 0;
  for (let i = body.length - 1, pos = 0; i >= 0; i--, pos++) {
    const n = Number(body[i]);
    sum += n * (pos % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10 === expected;
}
