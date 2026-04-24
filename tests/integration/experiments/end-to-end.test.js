/**
 * Tests d'intégration — shared/experiments/
 *
 * Simule le flow complet : définition d'expérience → buildExperimentsContext
 * sur N siren → vérification distribution + reproductibilité.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildExperimentsContext,
  assignVariant,
} = require('../../../shared/experiments');
const {
  _resetForTests,
  _setCacheForTests,
} = require('../../../shared/experiments/registry');

test.beforeEach(() => {
  _resetForTests();
});

test('end-to-end — 100 siren, distribution ~50/50 sur variantes equilibrees', async () => {
  _setCacheForTests([
    {
      experiment_id: 'enrichment_method',
      type: 'lead_enrichment',
      status: 'active',
      variants: [{ id: 'control', weight: 1 }, { id: 'cascade', weight: 1 }],
      scope: null,
    },
  ]);

  const counts = { control: 0, cascade: 0 };
  for (let i = 0; i < 100; i++) {
    const siren = String(100000000 + i);
    const ctx = await buildExperimentsContext({
      siren,
      beneficiaryId: 'oseys-test',
      type: 'lead_enrichment',
    });
    assert.equal(ctx.applied.length, 1);
    counts[ctx.applied[0].variant]++;
  }
  // 100 siren, variance attendue mais on doit avoir entre 30 et 70 par variante
  assert.ok(counts.control >= 30 && counts.control <= 70, `control=${counts.control}`);
  assert.ok(counts.cascade >= 30 && counts.cascade <= 70, `cascade=${counts.cascade}`);
  assert.equal(counts.control + counts.cascade, 100);
});

test('end-to-end — déterminisme cross-appel pour même SIREN', async () => {
  _setCacheForTests([
    {
      experiment_id: 'mail_personalisation',
      type: 'mail_personalisation',
      status: 'active',
      variants: [{ id: 'control', weight: 1 }, { id: 'personalized', weight: 1 }],
      scope: null,
    },
  ]);

  const siren = '555666777';
  const ctx1 = await buildExperimentsContext({
    siren, beneficiaryId: 'oseys-x', type: 'mail_personalisation',
  });
  const ctx2 = await buildExperimentsContext({
    siren, beneficiaryId: 'oseys-x', type: 'mail_personalisation',
  });
  assert.equal(ctx1.applied[0].variant, ctx2.applied[0].variant);
});

test('end-to-end — 2 expériences simultanées toutes deux appliquées', async () => {
  _setCacheForTests([
    {
      experiment_id: 'enrichment_method',
      type: 'lead_enrichment',
      status: 'active',
      variants: [{ id: 'A' }, { id: 'B' }],
      scope: null,
    },
    {
      experiment_id: 'send_time',
      type: 'send_time',
      status: 'active',
      variants: [{ id: 'morning' }, { id: 'afternoon' }],
      scope: null,
    },
  ]);

  const ctx = await buildExperimentsContext({
    siren: '111222333',
    beneficiaryId: 'oseys-x',
    // pas de filtre type → toutes les expériences actives applicables
  });
  assert.equal(ctx.applied.length, 2);
  const ids = ctx.applied.map((a) => a.experiment_id).sort();
  assert.deepEqual(ids, ['enrichment_method', 'send_time']);
});

test('end-to-end — scope bloque une expérience sur le mauvais bénéficiaire', async () => {
  _setCacheForTests([
    {
      experiment_id: 'morgane_only',
      type: 'lead_enrichment',
      status: 'active',
      variants: [{ id: 'A' }, { id: 'B' }],
      scope: { beneficiaryId: ['oseys-morgane'] },
    },
  ]);

  const ctx1 = await buildExperimentsContext({
    siren: '123456789',
    beneficiaryId: 'oseys-morgane',
    type: 'lead_enrichment',
  });
  const ctx2 = await buildExperimentsContext({
    siren: '123456789',
    beneficiaryId: 'oseys-johnny',
    type: 'lead_enrichment',
  });
  assert.equal(ctx1.applied.length, 1);
  assert.equal(ctx2.applied.length, 0);
});

test('end-to-end — shouldApplyVariant pilote le comportement aval', async () => {
  _setCacheForTests([
    {
      experiment_id: 'enrichment_method',
      type: 'lead_enrichment',
      status: 'active',
      variants: [{ id: 'cascade_off', weight: 1 }, { id: 'cascade_on', weight: 0 }],
      // weight 0 sur cascade_on → uniquement cascade_off attribué
      scope: null,
    },
  ]);

  const ctx = await buildExperimentsContext({
    siren: '999888777',
    beneficiaryId: 'oseys-x',
    type: 'lead_enrichment',
  });
  assert.equal(ctx.applied[0].variant, 'cascade_off');
  assert.equal(ctx.shouldApplyVariant('enrichment_method', 'cascade_off'), true);
  assert.equal(ctx.shouldApplyVariant('enrichment_method', 'cascade_on'), false);
});
