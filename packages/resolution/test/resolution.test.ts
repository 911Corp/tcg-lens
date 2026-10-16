import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from '../src/index.js';

const candidate = (overrides = {}) => ({
  entityId: 'entity-a',
  entityType: 'CARD_PRINTING' as const,
  score: 99,
  evidence: [],
  ...overrides
});

test('verified external ID auto matches', () => {
  const decision = resolve({ entityHint: 'CARD_PRINTING', sourceCode: 'tcgdex', candidates: [candidate({ verifiedExternalId: true })] });
  assert.equal(decision.status, 'AUTO_MATCH');
  assert.equal(decision.ruleId, 'VERIFIED_EXTERNAL_ID');
});

test('high visual score alone remains candidate match', () => {
  const decision = resolve({ entityHint: 'CARD_PRINTING', sourceCode: 'user_observation', candidates: [candidate({ score: 100 })] });
  assert.equal(decision.status, 'CANDIDATE_MATCH');
});

test('zero candidates creates new entity decision', () => {
  const decision = resolve({ entityHint: 'CARD_PRINTING', sourceCode: 'pokemon_jp', candidates: [] });
  assert.equal(decision.status, 'NEW_ENTITY');
});

test('conflicting strong identifiers quarantine resolution', () => {
  const decision = resolve({
    entityHint: 'SEALED_PRODUCT',
    sourceCode: 'cardtrader',
    candidates: [
      candidate({ entityType: 'SEALED_PRODUCT', verifiedBarcode: true }),
      candidate({ entityId: 'entity-b', entityType: 'SEALED_PRODUCT', verifiedExternalId: true })
    ]
  });
  assert.equal(decision.status, 'CONFLICT');
});
