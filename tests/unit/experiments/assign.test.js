/**
 * Tests unitaires — shared/experiments/assign.js
 *
 * Couvre SPEC_AB_TESTING §7.1 : déterminisme, distribution, weights,
 * edge cases (1 variante, weight 0, expIds différents).
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { assignVariant, _internals } = require('../../../shared/experiments/assign');

const VARIANTS_AB = [
  { id: 'A', weight: 1 },
  { id: 'B', weight: 1 },
];

// ─── Déterminisme ──────────────────────────────────────────────────────────

test('assignVariant — déterministe sur mêmes inputs', () => {
  const v1 = assignVariant('exp1', 'siren-1', VARIANTS_AB);
  const v2 = assignVariant('exp1', 'siren-1', VARIANTS_AB);
  const v3 = assignVariant('exp1', 'siren-1', VARIANTS_AB);
  assert.equal(v1, v2);
  assert.equal(v2, v3);
});

test('assignVariant — experimentId différent → assignation potentiellement différente', () => {
  // On n'affirme pas qu'elles diffèrent (elles peuvent coïncider par chance
  // sur un SIREN), mais sur un sample raisonnable la distribution diffère.
  let sameCount = 0;
  for (let i = 0; i < 100; i++) {
    const entity = `siren-${i}`;
    const v1 = assignVariant('exp1', entity, VARIANTS_AB);
    const v2 = assignVariant('exp2', entity, VARIANTS_AB);
    if (v1 === v2) sameCount++;
  }
  // Sur 100 entités, on s'attend à environ 50 coïncidences (hash indépendant)
  assert.ok(sameCount > 20 && sameCount < 80, `sameCount=${sameCount} suspect`);
});

// ─── Distribution ──────────────────────────────────────────────────────────

test('assignVariant — distribution uniforme sur 10k entities (±3%)', () => {
  let countA = 0;
  let countB = 0;
  for (let i = 0; i < 10000; i++) {
    const v = assignVariant('dist-test', `siren-${i}`, VARIANTS_AB);
    if (v === 'A') countA++;
    else if (v === 'B') countB++;
  }
  // Attendu ~5000 / ~5000 avec tolérance 3%
  const ratioA = countA / 10000;
  assert.ok(ratioA > 0.47 && ratioA < 0.53, `ratioA=${ratioA}`);
  assert.equal(countA + countB, 10000);
});

test('assignVariant — weights 3:1 distribution ~75/25', () => {
  const variants = [{ id: 'big', weight: 3 }, { id: 'small', weight: 1 }];
  let bigN = 0;
  for (let i = 0; i < 10000; i++) {
    const v = assignVariant('weight-test', `siren-${i}`, variants);
    if (v === 'big') bigN++;
  }
  const ratio = bigN / 10000;
  assert.ok(ratio > 0.72 && ratio < 0.78, `ratio=${ratio}`);
});

// ─── Edge cases ────────────────────────────────────────────────────────────

test('assignVariant — 1 seule variante → retourne toujours celle-ci', () => {
  const v = assignVariant('single', 'siren-1', [{ id: 'only', weight: 1 }]);
  assert.equal(v, 'only');
});

test('assignVariant — variante avec weight 0 ignorée', () => {
  const variants = [
    { id: 'A', weight: 1 },
    { id: 'disabled', weight: 0 },
    { id: 'B', weight: 1 },
  ];
  // Sur 1000 appels, aucune ne doit être 'disabled'
  for (let i = 0; i < 1000; i++) {
    const v = assignVariant('zero-weight', `siren-${i}`, variants);
    assert.notEqual(v, 'disabled');
  }
});

test('assignVariant — weight manquant → défaut 1', () => {
  const variants = [{ id: 'A' }, { id: 'B' }];
  const v = assignVariant('default-weight', 'siren-1', variants);
  assert.ok(['A', 'B'].includes(v));
});

test('assignVariant — toutes les variantes à 0 → fallback première variante', () => {
  const variants = [{ id: 'X', weight: 0 }, { id: 'Y', weight: 0 }];
  const v = assignVariant('all-zero', 'siren-1', variants);
  assert.equal(v, 'X');
});

// ─── Validation ───────────────────────────────────────────────────────────

test('assignVariant — experimentId vide → throw', () => {
  assert.throws(() => assignVariant('', 'siren-1', VARIANTS_AB), /experimentId/);
  assert.throws(() => assignVariant(null, 'siren-1', VARIANTS_AB), /experimentId/);
});

test('assignVariant — entityId vide → throw', () => {
  assert.throws(() => assignVariant('exp', '', VARIANTS_AB), /entityId/);
  assert.throws(() => assignVariant('exp', null, VARIANTS_AB), /entityId/);
});

test('assignVariant — variants non-array ou vide → throw', () => {
  assert.throws(() => assignVariant('exp', 'siren-1', []), /variants/);
  assert.throws(() => assignVariant('exp', 'siren-1', null), /variants/);
  assert.throws(() => assignVariant('exp', 'siren-1', 'nope'), /variants/);
});

// ─── normalizeWeight ───────────────────────────────────────────────────────

test('normalizeWeight — cas usuels', () => {
  assert.equal(_internals.normalizeWeight(undefined), 1);
  assert.equal(_internals.normalizeWeight(null), 1);
  assert.equal(_internals.normalizeWeight(0), 0);
  assert.equal(_internals.normalizeWeight(3), 3);
  assert.equal(_internals.normalizeWeight(-1), 0);
  assert.equal(_internals.normalizeWeight(NaN), 0);
  assert.equal(_internals.normalizeWeight('2'), 2);
});
