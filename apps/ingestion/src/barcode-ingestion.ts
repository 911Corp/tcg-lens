import type { SqlClient } from './tcgdex-canonical.js';
import { normalizeBarcodeClaim, type NormalizedBarcodeClaim } from '../../../packages/ingestion/src/index.js';
import { attachVerifiedBarcode } from './sealed-enrichment.js';

export interface BarcodeClaimInput {
  sourceId: string;
  sourceRecordId: string;
  rawValue: string;
  sourceExternalValue?: string;
  entityId?: string;
  confidence?: number;
  verified?: boolean;
  evidence?: Record<string, unknown>;
}

export async function ingestBarcodeClaim(db: SqlClient, input: BarcodeClaimInput): Promise<{
  status: 'CANDIDATE' | 'VERIFIED' | 'CONFLICT' | 'REJECTED';
  barcodeId?: string;
  gtin14?: string;
}> {
  let claim: NormalizedBarcodeClaim;
  try {
    claim = normalizeBarcodeClaim(input);
  } catch {
    return { status: 'REJECTED' };
  }
  if (!claim.checksumValid) return { status: 'REJECTED', gtin14: claim.gtin14 };

  const barcode = await db.query<{ barcode_id: string }>(
    `INSERT INTO barcodes(gtin14,checksum_valid) VALUES ($1,true)
     ON CONFLICT(gtin14) DO UPDATE SET checksum_valid=true
     RETURNING barcode_id`, [claim.gtin14]
  );
  const barcodeId = barcode.rows[0]?.barcode_id;
  if (!barcodeId) throw new Error('Unable to allocate barcode');

  await db.query(
    `INSERT INTO barcode_representations(barcode_id,scheme,raw_value)
     VALUES ($1,$2,$3) ON CONFLICT(scheme,raw_value) DO NOTHING`,
    [barcodeId, claim.scheme, claim.rawValue.replace(/\D/g, '')]
  );

  let claimStatus: 'CANDIDATE' | 'VERIFIED' | 'CONFLICT' = input.verified && input.entityId ? 'VERIFIED' : 'CANDIDATE';
  if (input.entityId && input.verified) {
    const attached = await attachVerifiedBarcode(db, { entityId: input.entityId, barcodeId, sourceRecordId: input.sourceRecordId, confidence: input.confidence ?? 1 });
    if (attached === 'CONFLICT') claimStatus = 'CONFLICT';
  }

  await db.query(
    `INSERT INTO barcode_claims(
       barcode_id,source_record_id,source_id,entity_id,namespace,source_external_value,scheme,raw_value,claim_status,confidence,evidence
     ) VALUES ($1,$2,$3,$4,'products',$5,$6,$7,$8,$9,$10::jsonb)
     ON CONFLICT DO NOTHING`,
    [barcodeId,input.sourceRecordId,input.sourceId,input.entityId ?? null,input.sourceExternalValue ?? null,
     claim.scheme,claim.rawValue.replace(/\D/g,''),claimStatus,input.confidence ?? (input.verified ? 1 : 0.8),JSON.stringify(input.evidence ?? {})]
  );

  if (claimStatus === 'CONFLICT' && input.entityId) {
    const other = await db.query<{ entity_id: string }>(`SELECT entity_id FROM entity_barcodes WHERE barcode_id=$1 AND status='VERIFIED'`, [barcodeId]);
    await db.query(
      `INSERT INTO data_conflicts(source_record_id,conflict_type,severity,entity_ids,evidence,status)
       VALUES ($1,'BARCODE_COLLISION','CRITICAL',$2::uuid[],$3::jsonb,'OPEN')`,
      [input.sourceRecordId, Array.from(new Set([input.entityId, ...other.rows.map(x => x.entity_id)])), JSON.stringify({ gtin14: claim.gtin14, raw: claim.rawValue })]
    );
  }
  return { status: claimStatus, barcodeId, gtin14: claim.gtin14 };
}

export function extractBarcodeCandidates(value: unknown): string[] {
  const found = new Set<string>();
  const visit = (v: unknown, key = '') => {
    if (v == null) return;
    if (typeof v === 'object') {
      if (Array.isArray(v)) for (const item of v) visit(item, key);
      else for (const [k, item] of Object.entries(v as Record<string, unknown>)) visit(item, k);
      return;
    }
    if (typeof v !== 'string' && typeof v !== 'number') return;
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!['upc','ean','jan','gtin','barcode','productcode'].includes(normalizedKey)) return;
    const digits = String(v).replace(/\D/g, '');
    if ([12,13,14].includes(digits.length)) found.add(digits);
  };
  visit(value);
  return [...found];
}
