/**
 * Tests unitaires — shared/worker.js (greffes Mem0)
 *
 * On ne teste pas bootstrapSequence end-to-end (trop de dépendances externes :
 * Pipedrive, Anthropic, Graph, Queue). On teste le helper pur
 * resolveMem0Enrichments qui porte la logique Mem0 ajoutée par D2.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveMem0Enrichments } = require('../../shared/worker');

function makeMem0Stub({ prospectResult = [], patternResult = [] } = {}) {
  const calls = { retrieveProspect: [], retrievePatterns: [] };
  const mem0 = {
    retrieveProspect: async (siren) => {
      calls.retrieveProspect.push(siren);
      return prospectResult;
    },
    retrievePatterns: async (ctx) => {
      calls.retrievePatterns.push(ctx);
      return patternResult;
    }
  };
  return { mem0, calls };
}

function makeContext() {
  const warnings = [];
  const logs = [];
  return {
    warnings,
    logs,
    context: {
      warn: (msg) => warnings.push(msg),
      log: (msg) => logs.push(msg)
    }
  };
}

test('resolveMem0Enrichments — lead.siren présent : retrieveProspect et retrievePatterns appelés, pas de warn', async () => {
  const { mem0, calls } = makeMem0Stub({
    prospectResult: [{ id: 'p1', memory: 'mem prospect' }],
    patternResult: [{ id: 'pat1', memory: 'mem pattern' }]
  });
  const { context, warnings } = makeContext();

  const res = await resolveMem0Enrichments({
    mem0,
    lead: { siren: '852115740', email: 'contact@acme.fr', secteur: 'services_btb' },
    context
  });

  assert.deepEqual(calls.retrieveProspect, ['852115740']);
  assert.deepEqual(calls.retrievePatterns, [{ sector: 'services_btb' }]);
  assert.deepEqual(res.prospectMemories, [{ id: 'p1', memory: 'mem prospect' }]);
  assert.deepEqual(res.patternMemories, [{ id: 'pat1', memory: 'mem pattern' }]);
  assert.equal(warnings.length, 0);
});

test('resolveMem0Enrichments — lead.siren absent : retrieveProspect skippé, retrievePatterns appelé, warn émis avec email du lead', async () => {
  const { mem0, calls } = makeMem0Stub({ patternResult: [{ id: 'pat1' }] });
  const { context, warnings } = makeContext();

  const res = await resolveMem0Enrichments({
    mem0,
    lead: { email: 'inconnu@example.fr', secteur: 'conseil' },
    context
  });

  assert.equal(calls.retrieveProspect.length, 0);
  assert.equal(calls.retrievePatterns.length, 1);
  assert.deepEqual(calls.retrievePatterns[0], { sector: 'conseil' });
  assert.deepEqual(res.prospectMemories, []);
  assert.deepEqual(res.patternMemories, [{ id: 'pat1' }]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /\[mem0\] prospect retrieve skipped: no SIREN for lead inconnu@example\.fr/);
});

test('resolveMem0Enrichments — mem0 null → [] pour les deux, aucun warn, aucun throw', async () => {
  const { context, warnings } = makeContext();
  const res = await resolveMem0Enrichments({
    mem0: null,
    lead: { email: 'x@y.com' },
    context
  });
  assert.deepEqual(res, { prospectMemories: [], patternMemories: [] });
  assert.equal(warnings.length, 0);
});

test('resolveMem0Enrichments — lead.siren et lead.email absents : warn tombe sur "(no email)"', async () => {
  const { mem0 } = makeMem0Stub();
  const { context, warnings } = makeContext();

  await resolveMem0Enrichments({ mem0, lead: {}, context });

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /no SIREN for lead \(no email\)/);
});

test('resolveMem0Enrichments — context.warn absent, fallback sur context.log', async () => {
  const { mem0 } = makeMem0Stub();
  const logs = [];
  const context = { log: (msg) => logs.push(msg) };
  await resolveMem0Enrichments({ mem0, lead: { email: 'a@b.fr' }, context });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /prospect retrieve skipped/);
});

test('resolveMem0Enrichments — context absent : pas de throw, comportement identique', async () => {
  const { mem0, calls } = makeMem0Stub({ patternResult: [] });
  const res = await resolveMem0Enrichments({ mem0, lead: { siren: '123', secteur: 'conseil' } });
  assert.deepEqual(calls.retrieveProspect, ['123']);
  assert.deepEqual(res, { prospectMemories: [], patternMemories: [] });
});
