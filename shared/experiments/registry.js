'use strict';

/**
 * Registry des expériences A/B — lecture Azure Table `Experiments` + cache.
 *
 * Schéma table (SPEC_AB_TESTING §3) :
 *   PartitionKey : 'active' (partition unique, <50 expériences simultanées)
 *   RowKey       : experiment_id (slug stable)
 *   Champs       : status, type, variants (JSON), scope (JSON), startedAt, ...
 *
 * Cache : 5 minutes en mémoire process. Toute modification de la table
 * prend effet après expiration du cache. C'est un compromis assumé : les
 * expériences sont déclenchées par Charli/Paul en config, pas en boucle
 * rapide, 5 min de latence est acceptable.
 *
 * Graceful degradation : si Azure Storage indisponible, retourne liste
 * vide. Les consommateurs (leadExhauster, profileProspect) continuent
 * sans tagging — c'est le comportement par défaut du pipeline.
 */

const { TableClient } = require('@azure/data-tables');
const { TABLE_EXPERIMENTS } = require('../lead-exhauster/schemas');

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

let _client = null;
let _cache = null;
let _cacheExpiresAt = 0;
let _clockFn = Date.now;

function getClient() {
  if (_client) return _client;
  const conn = process.env.AzureWebJobsStorage;
  if (!conn) return null;
  try {
    _client = TableClient.fromConnectionString(conn, TABLE_EXPERIMENTS);
    return _client;
  } catch {
    return null;
  }
}

/**
 * Charge toutes les expériences actives. Best effort, retourne [] en cas
 * d'erreur. Respecte le cache TTL 5 min.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.forceRefresh]  Ignore le cache
 * @returns {Promise<Array<ExperimentDefinition>>}
 */
async function loadActiveExperiments(opts = {}) {
  const now = _clockFn();
  if (!opts.forceRefresh && _cache && now < _cacheExpiresAt) {
    return _cache;
  }

  const client = getClient();
  if (!client) {
    _cache = [];
    _cacheExpiresAt = now + DEFAULT_CACHE_TTL_MS;
    return _cache;
  }

  const out = [];
  try {
    const iterator = client.listEntities({
      queryOptions: { filter: `PartitionKey eq 'active'` },
    });
    for await (const e of iterator) {
      const exp = hydrateExperiment(e);
      if (exp && exp.status === 'active') out.push(exp);
    }
  } catch {
    // on conserve le cache précédent si dispo, sinon []
    if (!_cache) _cache = [];
    _cacheExpiresAt = now + DEFAULT_CACHE_TTL_MS;
    return _cache;
  }

  _cache = out;
  _cacheExpiresAt = now + DEFAULT_CACHE_TTL_MS;
  return _cache;
}

/**
 * Filtre les expériences applicables à un contexte donné.
 *   - Match type si fourni
 *   - Match scope si défini : beneficiaryId / naf / tranche
 *   - scope null → s'applique à tout
 */
function filterByContext(experiments, context = {}) {
  return experiments.filter((exp) => {
    if (context.type && exp.type !== context.type) return false;
    const scope = exp.scope;
    if (!scope) return true;
    if (Array.isArray(scope.beneficiaryId) && scope.beneficiaryId.length > 0) {
      if (!context.beneficiaryId || !scope.beneficiaryId.includes(context.beneficiaryId)) {
        return false;
      }
    }
    if (Array.isArray(scope.naf) && scope.naf.length > 0) {
      if (!context.naf || !scope.naf.some((n) => context.naf.startsWith(n))) {
        return false;
      }
    }
    if (Array.isArray(scope.tranche) && scope.tranche.length > 0) {
      if (!context.tranche || !scope.tranche.includes(context.tranche)) {
        return false;
      }
    }
    return true;
  });
}

/**
 * Retourne les expériences actives applicables au contexte.
 * API publique principale du registry.
 */
async function getActiveExperiments(context = {}, opts = {}) {
  const all = await loadActiveExperiments(opts);
  return filterByContext(all, context);
}

/**
 * Hydrate une ligne Azure Table en ExperimentDefinition.
 * Parse variants/scope depuis JSON string. Retourne null si malformé.
 */
function hydrateExperiment(row) {
  if (!row || !row.rowKey) return null;
  const exp = {
    experiment_id: row.rowKey,
    name: row.name || row.rowKey,
    description: row.description || '',
    status: row.status || 'draft',
    type: row.type || 'unknown',
    variants: parseJsonSafe(row.variants, []),
    scope: parseJsonSafe(row.scope, null),
    startedAt: row.startedAt || null,
    endedAt: row.endedAt || null,
    createdBy: row.createdBy || null,
    notes: row.notes || '',
  };
  if (!Array.isArray(exp.variants) || exp.variants.length === 0) return null;
  return exp;
}

function parseJsonSafe(raw, fallback) {
  if (raw === null || raw === undefined || raw === '') return fallback;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

// ─── Helpers pour tests ────────────────────────────────────────────────────

function _resetForTests() {
  _client = null;
  _cache = null;
  _cacheExpiresAt = 0;
  _clockFn = Date.now;
}

function _setClockForTests(fn) {
  _clockFn = fn;
}

function _setCacheForTests(experiments, ttlMs = DEFAULT_CACHE_TTL_MS) {
  _cache = experiments;
  _cacheExpiresAt = _clockFn() + ttlMs;
}

module.exports = {
  loadActiveExperiments,
  getActiveExperiments,
  filterByContext,
  hydrateExperiment,
  DEFAULT_CACHE_TTL_MS,
  _resetForTests,
  _setClockForTests,
  _setCacheForTests,
};
