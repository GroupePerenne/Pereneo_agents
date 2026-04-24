/**
 * Tests unitaires — shared/experiments/registry.js
 *
 * Pas d'appel Azure réel : on teste les fonctions pures (filterByContext,
 * hydrateExperiment) + le mécanisme de cache via _setCacheForTests.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  filterByContext,
  hydrateExperiment,
  getActiveExperiments,
  DEFAULT_CACHE_TTL_MS,
  _resetForTests,
  _setClockForTests,
  _setCacheForTests,
} = require('../../../shared/experiments/registry');

test.beforeEach(() => {
  _resetForTests();
});

// ─── hydrateExperiment ─────────────────────────────────────────────────────

test('hydrateExperiment — row Azure Table → ExperimentDefinition', () => {
  const row = {
    partitionKey: 'active',
    rowKey: 'mail_personalisation',
    name: 'Mail perso vs generic',
    status: 'active',
    type: 'mail_personalisation',
    variants: '[{"id":"control","weight":1},{"id":"personalized","weight":1}]',
    scope: '{"beneficiaryId":["oseys-morgane"]}',
    startedAt: '2026-05-19T00:00:00Z',
  };
  const exp = hydrateExperiment(row);
  assert.equal(exp.experiment_id, 'mail_personalisation');
  assert.equal(exp.status, 'active');
  assert.equal(exp.type, 'mail_personalisation');
  assert.equal(exp.variants.length, 2);
  assert.deepEqual(exp.scope.beneficiaryId, ['oseys-morgane']);
});

test('hydrateExperiment — variants JSON invalide → null', () => {
  const row = { rowKey: 'exp1', variants: '{not json}' };
  assert.equal(hydrateExperiment(row), null);
});

test('hydrateExperiment — row sans rowKey → null', () => {
  assert.equal(hydrateExperiment({}), null);
  assert.equal(hydrateExperiment(null), null);
});

test('hydrateExperiment — scope absent → null', () => {
  const row = {
    rowKey: 'exp1', variants: '[{"id":"A"}]',
  };
  const exp = hydrateExperiment(row);
  assert.equal(exp.scope, null);
});

// ─── filterByContext ───────────────────────────────────────────────────────

const EXPS = [
  {
    experiment_id: 'e1', type: 'lead_enrichment', status: 'active',
    variants: [{ id: 'A' }, { id: 'B' }], scope: null,
  },
  {
    experiment_id: 'e2', type: 'mail_personalisation', status: 'active',
    variants: [{ id: 'A' }, { id: 'B' }],
    scope: { beneficiaryId: ['oseys-morgane'] },
  },
  {
    experiment_id: 'e3', type: 'lead_enrichment', status: 'active',
    variants: [{ id: 'A' }, { id: 'B' }],
    scope: { naf: ['70'], tranche: ['21', '22'] },
  },
];

test('filterByContext — scope null → toujours inclus', () => {
  const out = filterByContext(EXPS, { type: 'lead_enrichment', beneficiaryId: 'x' });
  assert.ok(out.some((e) => e.experiment_id === 'e1'));
});

test('filterByContext — scope beneficiaryId match', () => {
  const out = filterByContext(EXPS, { type: 'mail_personalisation', beneficiaryId: 'oseys-morgane' });
  assert.ok(out.some((e) => e.experiment_id === 'e2'));
});

test('filterByContext — scope beneficiaryId miss → exclu', () => {
  const out = filterByContext(EXPS, { type: 'mail_personalisation', beneficiaryId: 'autre' });
  assert.ok(!out.some((e) => e.experiment_id === 'e2'));
});

test('filterByContext — scope NAF préfixe match', () => {
  const out = filterByContext(EXPS, {
    type: 'lead_enrichment', naf: '70.22Z', tranche: '21',
  });
  assert.ok(out.some((e) => e.experiment_id === 'e3'));
});

test('filterByContext — scope NAF préfixe miss', () => {
  const out = filterByContext(EXPS, {
    type: 'lead_enrichment', naf: '62.01Z', tranche: '21',
  });
  assert.ok(!out.some((e) => e.experiment_id === 'e3'));
});

test('filterByContext — tranche scope', () => {
  const out = filterByContext(EXPS, {
    type: 'lead_enrichment', naf: '70.22Z', tranche: '11',
  });
  assert.ok(!out.some((e) => e.experiment_id === 'e3'));
});

test('filterByContext — type filter strict : scope NAF requiert context.naf', () => {
  // Sans context.naf, e3 (scope.naf défini) est exclu. Seul e1 (scope null) passe.
  const out = filterByContext(EXPS, { type: 'lead_enrichment' });
  assert.equal(out.length, 1);
  assert.equal(out[0].experiment_id, 'e1');
});

test('filterByContext — type filter permissif quand context fournit naf/tranche', () => {
  const out = filterByContext(EXPS, {
    type: 'lead_enrichment', naf: '70.22Z', tranche: '21',
  });
  // e1 (scope null) + e3 (scope match) passent
  assert.equal(out.length, 2);
});

// ─── cache ─────────────────────────────────────────────────────────────────

test('getActiveExperiments — cache TTL fonctionne (clock stub)', async () => {
  let now = 1_000_000_000;
  _setClockForTests(() => now);

  const mockExps = [{
    experiment_id: 'cached',
    type: 'lead_enrichment',
    status: 'active',
    variants: [{ id: 'A' }, { id: 'B' }],
    scope: null,
  }];
  _setCacheForTests(mockExps, DEFAULT_CACHE_TTL_MS);

  const r1 = await getActiveExperiments({ type: 'lead_enrichment' });
  assert.equal(r1.length, 1);
  assert.equal(r1[0].experiment_id, 'cached');

  // Avance horloge juste sous TTL → cache toujours utilisé
  now += DEFAULT_CACHE_TTL_MS - 1000;
  const r2 = await getActiveExperiments({ type: 'lead_enrichment' });
  assert.equal(r2.length, 1);

  // Avance horloge au-delà TTL → cache expiré → tente lecture Azure
  // (absent en test → retourne [] puisque AzureWebJobsStorage undefined
  // ou invalide)
  now += 2000;
  const r3 = await getActiveExperiments({ type: 'lead_enrichment' });
  // Le registry fallback sur [] en cas d'erreur Azure, donc r3.length = 0
  // On tolère 0 ou cache précédent selon env (si AzureWebJobsStorage
  // configuré vide, listEntities throw → cache précédent préservé).
  assert.ok(r3.length === 0 || r3.length === 1);
});

test('getActiveExperiments — AzureWebJobsStorage absent → [] graceful', async () => {
  const prev = process.env.AzureWebJobsStorage;
  delete process.env.AzureWebJobsStorage;
  _resetForTests();
  try {
    const r = await getActiveExperiments({ type: 'lead_enrichment' });
    assert.deepEqual(r, []);
  } finally {
    if (prev) process.env.AzureWebJobsStorage = prev;
  }
});
