/**
 * Tests unitaires — agents/david/orchestrator.js (greffes Mem0 D4)
 *
 * On ne teste PAS handleProspectReply end-to-end (il appelle Pipedrive,
 * Graph, Queue). On teste les helpers extraits par D4 qui portent la
 * nouvelle logique Mem0 :
 *   - persistInboundProspect : décisions de store (skip/no-siren/bounce)
 *   - resolveSirenForOrg     : remontée SIREN via Pipedrive (avec stub)
 *
 * Les sous-fonctions handlePositive/Question/etc. n'ont pas été touchées
 * par D4, elles sont couvertes par les tests d'intégration (étape 5).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  persistInboundProspect,
  resolveSirenForOrg,
} = require('../../../agents/david/orchestrator');

function makeMem0Stub({ storeReturns = { id: 'm1' } } = {}) {
  const calls = [];
  return {
    calls,
    mem0: {
      storeProspect: async (siren, memory) => {
        calls.push({ siren, memory });
        return storeReturns;
      },
    },
  };
}

function makeContext() {
  const warnings = [];
  const logs = [];
  return {
    warnings,
    logs,
    context: {
      warn: (m) => warnings.push(m),
      log: (m) => logs.push(m),
    },
  };
}

// ──────────────── persistInboundProspect ────────────────

test('persistInboundProspect — siren + mem0 actif → storeProspect appelé avec le bon SIREN et schéma correct', async () => {
  const { mem0, calls } = makeMem0Stub();
  const { context } = makeContext();

  const res = await persistInboundProspect({
    mem0,
    siren: '852115740',
    prospectClass: 'positive',
    fromAddress: 'm.durand@acme.fr',
    confidence: 0.92,
    decision: { resume_humain: 'intéressé, demande RDV' },
    context,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].siren, '852115740');
  assert.equal(calls[0].memory.company_name, null);
  const hist = calls[0].memory.interaction_history;
  assert.equal(hist.length, 1);
  assert.match(hist[0].date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(hist[0].type, 'email_received');
  assert.equal(hist[0].class, 'positive');
  assert.equal(hist[0].confidence, 0.92);
  assert.equal(hist[0].summary, 'intéressé, demande RDV');
  assert.equal(res.stored, true);
  assert.equal(res.siren, '852115740');
});

test('persistInboundProspect — siren absent → pas de store, warn émis avec fromAddress', async () => {
  const { mem0, calls } = makeMem0Stub();
  const { context, warnings } = makeContext();

  const res = await persistInboundProspect({
    mem0,
    siren: null,
    prospectClass: 'question',
    fromAddress: 'contact@inconnu.fr',
    confidence: 0.8,
    decision: { resume_humain: 'demande un devis' },
    context,
  });

  assert.equal(calls.length, 0);
  assert.equal(res.stored, false);
  assert.equal(res.reason, 'no_siren');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /\[mem0\] prospect store skipped: no SIREN for inbound contact@inconnu\.fr/);
});

test('persistInboundProspect — prospectClass bounce → skip silencieux (pas de store, pas de warn)', async () => {
  const { mem0, calls } = makeMem0Stub();
  const { context, warnings } = makeContext();

  const res = await persistInboundProspect({
    mem0,
    siren: '852115740',          // SIREN présent mais pas exploitable sur bounce
    prospectClass: 'bounce',
    fromAddress: 'postmaster@example.com',
    confidence: 1.0,
    decision: { resume_humain: 'NDR' },
    context,
  });

  assert.equal(calls.length, 0);
  assert.equal(res.stored, false);
  assert.equal(res.reason, 'bounce_skipped');
  assert.equal(warnings.length, 0);
});

test('persistInboundProspect — mem0 storeProspect retourne null (dégradation 429/timeout) : stored=false, pas de throw', async () => {
  const { mem0 } = makeMem0Stub({ storeReturns: null });
  const { context } = makeContext();

  const res = await persistInboundProspect({
    mem0,
    siren: '123456789',
    prospectClass: 'neutre',
    fromAddress: 'x@y.fr',
    confidence: 0.75,
    decision: { resume_humain: 'ok merci' },
    context,
  });

  assert.equal(res.stored, false);
  assert.equal(res.siren, '123456789');
});

test('persistInboundProspect — decision.resume_humain absent : fallback decision.summary puis chaîne vide, pas de throw', async () => {
  const { mem0, calls } = makeMem0Stub();
  const { context } = makeContext();

  // fallback sur decision.summary
  await persistInboundProspect({
    mem0, siren: '111', prospectClass: 'neutre', fromAddress: 'a@b.fr',
    confidence: 0.9, decision: { summary: 'fallback ok' }, context,
  });
  assert.equal(calls[0].memory.interaction_history[0].summary, 'fallback ok');

  // fallback ultime : chaîne vide
  await persistInboundProspect({
    mem0, siren: '222', prospectClass: 'neutre', fromAddress: 'c@d.fr',
    confidence: 0.9, decision: {}, context,
  });
  assert.equal(calls[1].memory.interaction_history[0].summary, '');

  // decision null : toujours pas de throw, summary = ''
  await persistInboundProspect({
    mem0, siren: '333', prospectClass: 'neutre', fromAddress: 'e@f.fr',
    confidence: 0.9, decision: null, context,
  });
  assert.equal(calls[2].memory.interaction_history[0].summary, '');
});

test('persistInboundProspect — mem0 null : retourne reason=mem0_off, aucun appel', async () => {
  const { context } = makeContext();
  const res = await persistInboundProspect({
    mem0: null,
    siren: '999',
    prospectClass: 'positive',
    fromAddress: 'a@b.fr',
    confidence: 0.9,
    decision: { resume_humain: 'x' },
    context,
  });
  assert.equal(res.stored, false);
  assert.equal(res.reason, 'mem0_off');
});

// ──────────────── resolveSirenForOrg ────────────────

test('resolveSirenForOrg — orgId null → null, pas d\'appel Pipedrive', async () => {
  let called = false;
  const pipedriveMod = { getOrganization: async () => { called = true; return {}; } };
  const res = await resolveSirenForOrg(null, { pipedriveMod });
  assert.equal(res, null);
  assert.equal(called, false);
});

test('resolveSirenForOrg — env PIPEDRIVE_ORG_FIELD_SIREN absente → null, pas d\'appel', async () => {
  const prev = process.env.PIPEDRIVE_ORG_FIELD_SIREN;
  delete process.env.PIPEDRIVE_ORG_FIELD_SIREN;
  try {
    let called = false;
    const pipedriveMod = { getOrganization: async () => { called = true; return { abc: '123' }; } };
    const res = await resolveSirenForOrg(42, { pipedriveMod });
    assert.equal(res, null);
    assert.equal(called, false);
  } finally {
    if (prev !== undefined) process.env.PIPEDRIVE_ORG_FIELD_SIREN = prev;
  }
});

test('resolveSirenForOrg — field présent → valeur retournée en string', async () => {
  const prev = process.env.PIPEDRIVE_ORG_FIELD_SIREN;
  process.env.PIPEDRIVE_ORG_FIELD_SIREN = 'hash_siren_xyz';
  try {
    const pipedriveMod = {
      getOrganization: async (id) => ({ id, name: 'ACME', hash_siren_xyz: 852115740 }),
    };
    const res = await resolveSirenForOrg(42, { pipedriveMod });
    assert.equal(res, '852115740');
  } finally {
    if (prev !== undefined) process.env.PIPEDRIVE_ORG_FIELD_SIREN = prev;
    else delete process.env.PIPEDRIVE_ORG_FIELD_SIREN;
  }
});

test('resolveSirenForOrg — field vide sur l\'org → null', async () => {
  const prev = process.env.PIPEDRIVE_ORG_FIELD_SIREN;
  process.env.PIPEDRIVE_ORG_FIELD_SIREN = 'hash_siren_xyz';
  try {
    const pipedriveMod = { getOrganization: async () => ({ name: 'ACME' }) };
    const res = await resolveSirenForOrg(42, { pipedriveMod });
    assert.equal(res, null);
  } finally {
    if (prev !== undefined) process.env.PIPEDRIVE_ORG_FIELD_SIREN = prev;
    else delete process.env.PIPEDRIVE_ORG_FIELD_SIREN;
  }
});

test('resolveSirenForOrg — Pipedrive throw → null + warn log, pas de propagation', async () => {
  const prev = process.env.PIPEDRIVE_ORG_FIELD_SIREN;
  process.env.PIPEDRIVE_ORG_FIELD_SIREN = 'hash_siren_xyz';
  const { context, warnings } = makeContext();
  try {
    const pipedriveMod = { getOrganization: async () => { throw new Error('Pipedrive down'); } };
    const res = await resolveSirenForOrg(42, { context, pipedriveMod });
    assert.equal(res, null);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /\[mem0\] siren lookup failed for org 42.*Pipedrive down/);
  } finally {
    if (prev !== undefined) process.env.PIPEDRIVE_ORG_FIELD_SIREN = prev;
    else delete process.env.PIPEDRIVE_ORG_FIELD_SIREN;
  }
});
