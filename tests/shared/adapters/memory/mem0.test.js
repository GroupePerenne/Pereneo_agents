/**
 * Tests unitaires — shared/adapters/memory/mem0.js
 *
 * Exécution : node --test tests/
 * Contraintes :
 *   - Zero dépendance externe (node:test + node:assert/strict).
 *   - Pas de réseau : le constructor reçoit toujours un client stub injecté,
 *     jamais de MEM0_API_KEY. Si un test fait un vrai appel api.mem0.ai,
 *     c'est un bug de stubbing.
 *   - Stubs manuels via closures qui capturent les args et flags qui
 *     forcent un comportement (throw, return custom, hang).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  Mem0Adapter,
  NS_PROSPECT,
  NS_CONSULTANT,
  NS_PATTERN
} = require('../../../../shared/adapters/memory/mem0');

// ──────────────────── helpers ────────────────────

/**
 * Construit un client stub Mem0 minimal.
 * Overrides possibles :
 *   searchReturns / addReturns  — valeur forcée
 *   searchThrows  / addThrows   — erreur levée
 *   searchHangs   / addHangs    — promise qui ne résout jamais (→ timeout)
 */
function makeClient(overrides = {}) {
  const calls = { search: [], add: [] };
  const stub = {
    search: async (query, opts) => {
      calls.search.push({ query, opts });
      if (overrides.searchHangs) return new Promise(() => {});
      if (overrides.searchThrows) throw overrides.searchThrows;
      return Object.prototype.hasOwnProperty.call(overrides, 'searchReturns')
        ? overrides.searchReturns
        : { results: [] };
    },
    add: async (messages, opts) => {
      calls.add.push({ messages, opts });
      if (overrides.addHangs) return new Promise(() => {});
      if (overrides.addThrows) throw overrides.addThrows;
      return Object.prototype.hasOwnProperty.call(overrides, 'addReturns')
        ? overrides.addReturns
        : [{ id: 'mem_stub_1' }];
    }
  };
  return { stub, calls };
}

function makeLogger() {
  const calls = { info: [], warn: [], error: [] };
  return {
    logger: {
      info: (...a) => calls.info.push(a),
      warn: (...a) => calls.warn.push(a),
      error: (...a) => calls.error.push(a)
    },
    calls
  };
}

function namedError(name, { status, code, message } = {}) {
  const e = new Error(message || name);
  e.name = name;
  if (status !== undefined) e.status = status;
  if (code) e.code = code;
  return e;
}

function makeAdapter(clientStub, { logger, timeoutMs } = {}) {
  return new Mem0Adapter({ client: clientStub, logger, timeoutMs });
}

// ──────────────────── retrieveProspect ────────────────────

test('retrieveProspect — user_id namespacé dans filters et topK par défaut 20', async () => {
  const { stub, calls } = makeClient();
  const a = makeAdapter(stub);
  await a.retrieveProspect('123456789');
  assert.equal(calls.search.length, 1);
  assert.equal(calls.search[0].opts.filters.user_id, 'prospect:123456789');
  assert.equal(calls.search[0].opts.topK, 20);
});

test('retrieveProspect — topK override respecté', async () => {
  const { stub, calls } = makeClient();
  const a = makeAdapter(stub);
  await a.retrieveProspect('123456789', { topK: 5 });
  assert.equal(calls.search[0].opts.topK, 5);
});

test('retrieveProspect — query custom forwarded', async () => {
  const { stub, calls } = makeClient();
  const a = makeAdapter(stub);
  await a.retrieveProspect('123456789', { query: 'dernières interactions' });
  assert.equal(calls.search[0].query, 'dernières interactions');
});

test('retrieveProspect — retourne [] si SDK renvoie results: []', async () => {
  const { stub } = makeClient({ searchReturns: { results: [] } });
  const a = makeAdapter(stub);
  const res = await a.retrieveProspect('123456789');
  assert.deepEqual(res, []);
});

test('retrieveProspect — retourne [] si SDK renvoie null', async () => {
  const { stub } = makeClient({ searchReturns: null });
  const a = makeAdapter(stub);
  const res = await a.retrieveProspect('123456789');
  assert.deepEqual(res, []);
});

test('retrieveProspect — retourne [] si SDK renvoie undefined', async () => {
  const { stub } = makeClient({ searchReturns: undefined });
  const a = makeAdapter(stub);
  const res = await a.retrieveProspect('123456789');
  assert.deepEqual(res, []);
});

// ──────────────────── retrieveConsultant ────────────────────

test('retrieveConsultant — user_id namespacé dans filters et topK défaut 20', async () => {
  const { stub, calls } = makeClient();
  const a = makeAdapter(stub);
  await a.retrieveConsultant('osey-morgane-dupont');
  assert.equal(calls.search[0].opts.filters.user_id, 'consultant:osey-morgane-dupont');
  assert.equal(calls.search[0].opts.topK, 20);
});

test('retrieveConsultant — topK override', async () => {
  const { stub, calls } = makeClient();
  const a = makeAdapter(stub);
  await a.retrieveConsultant('osey-johnny', { topK: 3 });
  assert.equal(calls.search[0].opts.topK, 3);
});

// ──────────────────── retrievePatterns ────────────────────

test('retrievePatterns — user_id pattern:global dans filters et topK défaut 10', async () => {
  const { stub, calls } = makeClient();
  const a = makeAdapter(stub);
  await a.retrievePatterns({ sector: 'services_btb' });
  assert.equal(calls.search[0].opts.filters.user_id, 'pattern:global');
  assert.equal(calls.search[0].opts.topK, 10);
});

test('retrievePatterns — metadata sector + time_window propagée dans filters.metadata', async () => {
  const { stub, calls } = makeClient();
  const a = makeAdapter(stub);
  await a.retrievePatterns({ sector: 'services_btb', time_window: '08h-10h_mardi_jeudi' });
  assert.deepEqual(calls.search[0].opts.filters.metadata, {
    sector: 'services_btb',
    time_window: '08h-10h_mardi_jeudi'
  });
});

test('retrievePatterns — context vide → pas de clé metadata dans filters', async () => {
  const { stub, calls } = makeClient();
  const a = makeAdapter(stub);
  await a.retrievePatterns({});
  assert.equal(Object.prototype.hasOwnProperty.call(calls.search[0].opts.filters, 'metadata'), false);
});

test('retrievePatterns — seul sector fourni, time_window absent de filters.metadata', async () => {
  const { stub, calls } = makeClient();
  const a = makeAdapter(stub);
  await a.retrievePatterns({ sector: 'conseil' });
  assert.deepEqual(calls.search[0].opts.filters.metadata, { sector: 'conseil' });
  assert.equal(
    Object.prototype.hasOwnProperty.call(calls.search[0].opts.filters.metadata, 'time_window'),
    false
  );
});

test('retrievePatterns — topK override à 25', async () => {
  const { stub, calls } = makeClient();
  const a = makeAdapter(stub);
  await a.retrievePatterns({ sector: 'conseil' }, { topK: 25 });
  assert.equal(calls.search[0].opts.topK, 25);
});

// ──────────────────── storeProspect ────────────────────

test('storeProspect — userId namespacé, infer:false, metadata siren + company_name', async () => {
  const { stub, calls } = makeClient();
  const a = makeAdapter(stub);
  await a.storeProspect('852115740', {
    company_name: 'OSEYS RESEAU SAS',
    angles_tested: ['ROI_quantifié']
  });
  assert.equal(calls.add.length, 1);
  const { opts } = calls.add[0];
  assert.equal(opts.userId, 'prospect:852115740');
  assert.equal(opts.infer, false);
  assert.equal(opts.metadata.siren, '852115740');
  assert.equal(opts.metadata.company_name, 'OSEYS RESEAU SAS');
  assert.equal(opts.metadata.namespace, NS_PROSPECT);
});

test('storeProspect — messages contient la mémoire JSON-stringifiée', async () => {
  const { stub, calls } = makeClient();
  const a = makeAdapter(stub);
  const memory = { company_name: 'ACME', decision_makers: [] };
  await a.storeProspect('111', memory);
  const { messages } = calls.add[0];
  assert.equal(messages[0].role, 'user');
  assert.deepEqual(JSON.parse(messages[0].content), memory);
});

test('storeProspect — siren manquant → throw', async () => {
  const { stub } = makeClient();
  const a = makeAdapter(stub);
  await assert.rejects(() => a.storeProspect('', { company_name: 'X' }), /siren requis/);
  await assert.rejects(() => a.storeProspect(null, { company_name: 'X' }), /siren requis/);
});

test('storeProspect — memory manquant → throw', async () => {
  const { stub } = makeClient();
  const a = makeAdapter(stub);
  await assert.rejects(() => a.storeProspect('123', null), /memory requis/);
});

// ──────────────────── storeConsultant ────────────────────

test('storeConsultant — userId namespacé, infer:false, metadata consultant_id + display_name', async () => {
  const { stub, calls } = makeClient();
  const a = makeAdapter(stub);
  await a.storeConsultant('osey-morgane-dupont', {
    display_name: 'Morgane Dupont',
    preferred_tone: 'familier_chaleureux'
  });
  const { opts } = calls.add[0];
  assert.equal(opts.userId, 'consultant:osey-morgane-dupont');
  assert.equal(opts.infer, false);
  assert.equal(opts.metadata.consultant_id, 'osey-morgane-dupont');
  assert.equal(opts.metadata.display_name, 'Morgane Dupont');
  assert.equal(opts.metadata.namespace, NS_CONSULTANT);
});

test('storeConsultant — consultantId manquant → throw', async () => {
  const { stub } = makeClient();
  const a = makeAdapter(stub);
  await assert.rejects(() => a.storeConsultant('', { display_name: 'X' }), /consultantId requis/);
});

// ──────────────────── storePattern ────────────────────

test('storePattern — userId pattern:global, infer:false, metadata complète', async () => {
  const { stub, calls } = makeClient();
  const a = makeAdapter(stub);
  await a.storePattern({
    pattern_id: 'email-opening-services-btb-morning',
    scope: 'global',
    context: { sector: 'services_btb', time_window: '08h-10h_mardi_jeudi' },
    pattern: 'objet_question_ouverte_personnalisée_entreprise',
    performance: { open_rate: 0.42 },
    confidence: 'high'
  });
  const { opts } = calls.add[0];
  assert.equal(opts.userId, 'pattern:global');
  assert.equal(opts.infer, false);
  assert.equal(opts.metadata.pattern_id, 'email-opening-services-btb-morning');
  assert.equal(opts.metadata.scope, 'global');
  assert.equal(opts.metadata.sector, 'services_btb');
  assert.equal(opts.metadata.time_window, '08h-10h_mardi_jeudi');
  assert.equal(opts.metadata.confidence, 'high');
  assert.equal(opts.metadata.namespace, NS_PATTERN);
});

test('storePattern — scope par défaut "global" si absent', async () => {
  const { stub, calls } = makeClient();
  const a = makeAdapter(stub);
  await a.storePattern({
    pattern_id: 'p1',
    context: { sector: 'conseil' }
  });
  assert.equal(calls.add[0].opts.metadata.scope, 'global');
});

test('storePattern — pattern_id manquant → throw', async () => {
  const { stub } = makeClient();
  const a = makeAdapter(stub);
  await assert.rejects(() => a.storePattern({ context: {} }), /pattern_id requis/);
  await assert.rejects(() => a.storePattern(null), /pattern_id requis/);
});

test('storePattern — time_window absent → pas de clé time_window dans metadata (stripUndefined)', async () => {
  const { stub, calls } = makeClient();
  const a = makeAdapter(stub);
  await a.storePattern({
    pattern_id: 'p2',
    context: { sector: 'conseil' },
    confidence: 'medium'
  });
  const meta = calls.add[0].opts.metadata;
  assert.equal(Object.prototype.hasOwnProperty.call(meta, 'time_window'), false);
  assert.equal(meta.sector, 'conseil');
});

// ──────────────────── paths d'erreur ────────────────────

test('erreur 429 (RateLimitError) sur retrieve → retourne [], pas de throw', async () => {
  const rate = namedError('RateLimitError', { status: 429 });
  const { stub } = makeClient({ searchThrows: rate });
  const a = makeAdapter(stub);
  const res = await a.retrieveProspect('123');
  assert.deepEqual(res, []);
});

test('erreur 429 sur store → retourne null, pas de throw', async () => {
  const rate = namedError('RateLimitError', { status: 429 });
  const { stub } = makeClient({ addThrows: rate });
  const a = makeAdapter(stub);
  const res = await a.storeProspect('123', { company_name: 'X' });
  assert.equal(res, null);
});

test('timeout sur retrieve (SDK hang) → retourne [], pas de throw', async () => {
  const { stub } = makeClient({ searchHangs: true });
  const a = makeAdapter(stub, { timeoutMs: 20 });
  const res = await a.retrieveConsultant('osey-morgane');
  assert.deepEqual(res, []);
});

test('timeout sur store (SDK hang) → retourne null, pas de throw', async () => {
  const { stub } = makeClient({ addHangs: true });
  const a = makeAdapter(stub, { timeoutMs: 20 });
  const res = await a.storeConsultant('osey-morgane', { display_name: 'M' });
  assert.equal(res, null);
});

test('erreur 400 ValidationError sur retrieve → propagée', async () => {
  const val = namedError('ValidationError', { status: 400, message: 'invalid query' });
  const { stub } = makeClient({ searchThrows: val });
  const a = makeAdapter(stub);
  await assert.rejects(() => a.retrieveProspect('123'), /invalid query/);
});

test('erreur 400 ValidationError sur store → propagée', async () => {
  const val = namedError('ValidationError', { status: 400, message: 'bad metadata' });
  const { stub } = makeClient({ addThrows: val });
  const a = makeAdapter(stub);
  await assert.rejects(() => a.storeProspect('123', { company_name: 'X' }), /bad metadata/);
});

// ──────────────────── cross-cutting ────────────────────

test('logger — succès retrieve appelle logger.info', async () => {
  const { stub } = makeClient();
  const { logger, calls } = makeLogger();
  const a = makeAdapter(stub, { logger });
  await a.retrieveProspect('123');
  assert.equal(calls.info.length, 1);
  assert.equal(calls.warn.length, 0);
  assert.match(calls.info[0][0], /\[mem0\] retrieve ns=prospect id=123 success=true/);
  assert.equal(calls.info[0][1].namespace, NS_PROSPECT);
  assert.equal(calls.info[0][1].count, 0);
});

test('logger — 429 dégradé appelle logger.warn avec degraded:true', async () => {
  const rate = namedError('RateLimitError', { status: 429 });
  const { stub } = makeClient({ searchThrows: rate });
  const { logger, calls } = makeLogger();
  const a = makeAdapter(stub, { logger });
  await a.retrieveProspect('123');
  assert.equal(calls.warn.length, 1);
  assert.equal(calls.info.length, 0);
  assert.equal(calls.warn[0][1].success, false);
  assert.equal(calls.warn[0][1].degraded, true);
  assert.equal(calls.warn[0][1].error, 'RateLimitError');
});

test('logger — succès store appelle logger.info avec infer dans l\'entry', async () => {
  const { stub } = makeClient();
  const { logger, calls } = makeLogger();
  const a = makeAdapter(stub, { logger });
  await a.storePattern({
    pattern_id: 'p1',
    context: { sector: 'conseil' }
  });
  assert.equal(calls.info.length, 1);
  assert.equal(calls.info[0][1].infer, false);
});

test('constructor — sans apiKey ni client ni MEM0_API_KEY → throw', () => {
  const prev = process.env.MEM0_API_KEY;
  delete process.env.MEM0_API_KEY;
  try {
    assert.throws(() => new Mem0Adapter({}), /MEM0_API_KEY/);
  } finally {
    if (prev !== undefined) process.env.MEM0_API_KEY = prev;
  }
});
