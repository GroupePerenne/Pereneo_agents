/**
 * Tests unitaires — shared/experiments/tag.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildExperimentsContext,
  wrapContext,
  emptyContext,
} = require('../../../shared/experiments/tag');
const {
  _resetForTests,
  _setCacheForTests,
  _setClockForTests,
} = require('../../../shared/experiments/registry');

test.beforeEach(() => {
  _resetForTests();
});

// ─── wrapContext ──────────────────────────────────────────────────────────

test('wrapContext — expose shouldApplyVariant', () => {
  const ctx = wrapContext([
    { experiment_id: 'exp1', variant: 'A', type: 'lead_enrichment' },
  ]);
  assert.equal(ctx.shouldApplyVariant('exp1', 'A'), true);
  assert.equal(ctx.shouldApplyVariant('exp1', 'B'), false);
  assert.equal(ctx.shouldApplyVariant('nope', 'A'), false);
});

test('wrapContext — applied préservé', () => {
  const applied = [{ experiment_id: 'x', variant: 'A', type: 'any' }];
  const ctx = wrapContext(applied);
  assert.equal(ctx.applied.length, 1);
  assert.equal(ctx.applied[0].experiment_id, 'x');
});

test('emptyContext — applied vide, shouldApplyVariant false partout', () => {
  const ctx = emptyContext();
  assert.deepEqual(ctx.applied, []);
  assert.equal(ctx.shouldApplyVariant('any', 'any'), false);
});

// ─── buildExperimentsContext ───────────────────────────────────────────────

test('buildExperimentsContext — applique assignVariant pour chaque expérience', async () => {
  _setCacheForTests([
    {
      experiment_id: 'enrichment_method',
      type: 'lead_enrichment',
      status: 'active',
      variants: [{ id: 'control', weight: 1 }, { id: 'cascade', weight: 1 }],
      scope: null,
    },
  ]);

  const ctx = await buildExperimentsContext({
    siren: '123456789',
    beneficiaryId: 'oseys-x',
    type: 'lead_enrichment',
  });
  assert.equal(ctx.applied.length, 1);
  assert.equal(ctx.applied[0].experiment_id, 'enrichment_method');
  assert.ok(['control', 'cascade'].includes(ctx.applied[0].variant));
});

test('buildExperimentsContext — scope limite les expériences appliquées', async () => {
  _setCacheForTests([
    {
      experiment_id: 'e1',
      type: 'lead_enrichment',
      status: 'active',
      variants: [{ id: 'A' }, { id: 'B' }],
      scope: { beneficiaryId: ['oseys-morgane'] },
    },
    {
      experiment_id: 'e2',
      type: 'lead_enrichment',
      status: 'active',
      variants: [{ id: 'A' }, { id: 'B' }],
      scope: null,
    },
  ]);

  const ctx = await buildExperimentsContext({
    siren: '123456789',
    beneficiaryId: 'oseys-johnny', // pas morgane
    type: 'lead_enrichment',
  });
  // Seule e2 (scope null) s'applique
  assert.equal(ctx.applied.length, 1);
  assert.equal(ctx.applied[0].experiment_id, 'e2');
});

test('buildExperimentsContext — sans siren → applied vide', async () => {
  _setCacheForTests([
    {
      experiment_id: 'e1',
      type: 'lead_enrichment',
      status: 'active',
      variants: [{ id: 'A' }, { id: 'B' }],
      scope: null,
    },
  ]);
  const ctx = await buildExperimentsContext({ beneficiaryId: 'x', type: 'lead_enrichment' });
  assert.deepEqual(ctx.applied, []);
});

test('buildExperimentsContext — aucune expérience active → applied vide', async () => {
  _setCacheForTests([]);
  const ctx = await buildExperimentsContext({
    siren: '123456789',
    beneficiaryId: 'x',
    type: 'lead_enrichment',
  });
  assert.deepEqual(ctx.applied, []);
});

test('buildExperimentsContext — déterminisme', async () => {
  _setCacheForTests([
    {
      experiment_id: 'enrichment_method',
      type: 'lead_enrichment',
      status: 'active',
      variants: [{ id: 'A' }, { id: 'B' }],
      scope: null,
    },
  ]);

  const ctx1 = await buildExperimentsContext({ siren: '999999999', type: 'lead_enrichment' });
  const ctx2 = await buildExperimentsContext({ siren: '999999999', type: 'lead_enrichment' });
  assert.equal(ctx1.applied[0].variant, ctx2.applied[0].variant);
});
