'use strict';

/**
 * Patterns learner — apprentissage des patterns email self-learning.
 *
 * Job batch hebdo (SPEC §6) : scanne `LeadContacts.feedbackStatus` mis à
 * jour dans la semaine, agrège par (nafDivision, tranche, patternId) et
 * met à jour la table `EmailPatterns` :
 *   - successRate = replied / sampleSize
 *   - bounceRate  = (bounced + spam_flagged) / sampleSize
 *   - active      = ! (bounceRate > 0.30 && sampleSize > 20)
 *
 * La table `EmailPatterns` sert ensuite à `patterns.rankPatternsForContext`
 * (Jalon 4+) pour privilégier les patterns qui marchent dans un secteur
 * donné. En V1 les bootstrap patterns restent le fallback si aucun
 * pattern appris n'existe pour le (nafDivision, tranche).
 *
 * Module core **pur** : prend des rows en entrée, retourne des updates.
 * L'écriture Azure Table vit dans une fonction séparée `applyPatternUpdates`
 * pour que les tests puissent valider l'agrégation sans mock Azure.
 *
 * Le wrapper Azure Timer Function vit dans `functions/patternsLearner/`.
 *
 * SPEC : SPEC_LEAD_EXHAUSTER §6 + ARCHITECTURE §7.13.3.
 */

const { TableClient } = require('@azure/data-tables');
const { TABLE_EMAIL_PATTERNS, TABLE_LEAD_CONTACTS } = require('./schemas');

// ─── Constantes produit ───────────────────────────────────────────────────

const BOUNCE_RATE_DEACTIVATION_THRESHOLD = 0.30;
const MIN_SAMPLE_SIZE_FOR_DEACTIVATION = 20;
const DEFAULT_LOOKBACK_DAYS = 7;

// ─── Parsing signals ──────────────────────────────────────────────────────

// Signals possibles capturant le pattern utilisé (cf. resolveEmail.js) :
//   'pattern_first.last_cross_checked_scraping'
//   'pattern_first.last_under_threshold'
//   'pattern_f.last_cross_checked_scraping'
//   'pattern_contact_under_threshold' (catch-all)
// On extrait l'id entre `pattern_` et `_<tag>`.
const PATTERN_SIGNAL_REGEX = /^pattern_([a-z][a-z0-9._-]*)_(cross_checked_scraping|under_threshold)$/i;

/**
 * Extrait l'id du pattern utilisé depuis les signals d'une résolution.
 * Retourne null si aucun signal pattern trouvé.
 *
 * @param {string[]|string} signals  Array de signals ou JSON stringifié.
 * @returns {string|null}
 */
function extractPatternIdFromSignals(signals) {
  const list = normalizeSignals(signals);
  for (const s of list) {
    const m = PATTERN_SIGNAL_REGEX.exec(String(s));
    if (m) return m[1];
  }
  return null;
}

function normalizeSignals(signals) {
  if (!signals) return [];
  if (Array.isArray(signals)) return signals;
  if (typeof signals === 'string') {
    // Peut venir d'Azure Table JSON stringifié
    try {
      const parsed = JSON.parse(signals);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [signals];
    }
  }
  return [];
}

/**
 * Classifie un feedbackStatus en contribution pour le scoring pattern :
 *   - 'replied'                  → success (email validé + engagement)
 *   - 'delivered'                → neutral (email livré, pas d'info qualité)
 *   - 'bounced' / 'spam_flagged' → failure (pattern défaillant)
 *   - null / inconnu             → unknown (ignoré)
 *
 * @param {string|null} status
 * @returns {'success'|'failure'|'neutral'|'unknown'}
 */
function classifyFeedback(status) {
  if (!status) return 'unknown';
  const s = String(status).toLowerCase().trim();
  if (s === 'replied') return 'success';
  if (s === 'delivered') return 'neutral';
  if (s === 'bounced' || s === 'spam_flagged') return 'failure';
  return 'unknown';
}

/**
 * Extrait la division NAF (2 premiers chiffres) depuis un code NAF complet.
 *   "70.22Z" → "70"
 *   "62.02A" → "62"
 *   "" / null → "" (bucket fallback)
 */
function nafDivisionOf(naf) {
  if (!naf || typeof naf !== 'string') return '';
  const m = /^(\d{2})/.exec(naf);
  return m ? m[1] : '';
}

// ─── Agrégation ───────────────────────────────────────────────────────────

/**
 * Agrège une liste de LeadContactRow par (nafDivision, tranche, patternId).
 * Seules les rows avec pattern extractible + feedback classifiable sont
 * prises en compte.
 *
 * @param {LeadContactRow[]} rows
 * @returns {Map<string, { nafDivision, tranche, patternId, sampleSize, successes, bounces, neutral, lastFeedbackAt }>}
 */
function aggregateRows(rows) {
  const out = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const patternId = extractPatternIdFromSignals(row.signals);
    if (!patternId) continue;

    const cls = classifyFeedback(row.feedbackStatus);
    if (cls === 'unknown') continue;

    const nafDivision = nafDivisionOf(row.naf);
    const tranche = String(row.tranche || '');
    const key = `${nafDivision}|${tranche}|${patternId}`;

    let bucket = out.get(key);
    if (!bucket) {
      bucket = {
        nafDivision, tranche, patternId,
        sampleSize: 0, successes: 0, bounces: 0, neutral: 0,
        lastFeedbackAt: '',
      };
      out.set(key, bucket);
    }
    bucket.sampleSize++;
    if (cls === 'success') bucket.successes++;
    else if (cls === 'failure') bucket.bounces++;
    else if (cls === 'neutral') bucket.neutral++;
    if (row.feedbackAt && row.feedbackAt > bucket.lastFeedbackAt) {
      bucket.lastFeedbackAt = row.feedbackAt;
    }
  }
  return out;
}

/**
 * Fusionne les compteurs d'un bucket agrégé avec ceux d'un row EmailPatterns
 * existant (s'il existe). Calcule successRate et bounceRate.
 *
 * @param {Object} bucket              Retour de aggregateRows
 * @param {Object|null} existingRow    Row actuel dans EmailPatterns (ou null)
 * @returns {EmailPatternRow}
 */
function mergeWithExisting(bucket, existingRow) {
  const prev = existingRow || {};
  // Les colonnes de compteurs ne font pas partie du schéma SPEC initial
  // (qui ne stocke que les taux). Pour pouvoir merger en incrementally,
  // on stocke aussi sampleSizeCumulative / bouncesCumulative / successesCumulative
  // côté table. Extension logique non-breaking.
  const prevSample = Number(prev.sampleSize) || 0;
  const prevSuccesses = Number(prev.successesCumulative || prev.successes) || 0;
  const prevBounces = Number(prev.bouncesCumulative || prev.bounces) || 0;

  const sampleSize = prevSample + bucket.sampleSize;
  const successes = prevSuccesses + bucket.successes;
  const bounces = prevBounces + bucket.bounces;
  // neutral (delivered) compté dans sampleSize mais pas dans les rates

  const successRate = sampleSize > 0 ? successes / sampleSize : 0;
  const bounceRate = sampleSize > 0 ? bounces / sampleSize : 0;
  const active = !(bounceRate > BOUNCE_RATE_DEACTIVATION_THRESHOLD
    && sampleSize > MIN_SAMPLE_SIZE_FOR_DEACTIVATION);

  return {
    pattern: bucket.patternId,
    naf: bucket.nafDivision,
    tranche: bucket.tranche,
    sampleSize,
    successesCumulative: successes,
    bouncesCumulative: bounces,
    successRate,
    bounceRate,
    active,
    lastUpdatedAt: new Date().toISOString(),
  };
}

/**
 * Détermine la décision d'activation (utilisé aussi par les tests).
 */
function shouldDeactivate(sampleSize, bounceRate) {
  return bounceRate > BOUNCE_RATE_DEACTIVATION_THRESHOLD
    && sampleSize > MIN_SAMPLE_SIZE_FOR_DEACTIVATION;
}

// ─── Lecture / écriture Azure Table ───────────────────────────────────────

let _leadContactsClient = null;
let _emailPatternsClient = null;

function getLeadContactsClient() {
  if (_leadContactsClient) return _leadContactsClient;
  const conn = process.env.AzureWebJobsStorage;
  if (!conn) return null;
  try {
    _leadContactsClient = TableClient.fromConnectionString(conn, TABLE_LEAD_CONTACTS);
    return _leadContactsClient;
  } catch {
    return null;
  }
}

function getEmailPatternsClient() {
  if (_emailPatternsClient) return _emailPatternsClient;
  const conn = process.env.AzureWebJobsStorage;
  if (!conn) return null;
  try {
    _emailPatternsClient = TableClient.fromConnectionString(conn, TABLE_EMAIL_PATTERNS);
    return _emailPatternsClient;
  } catch {
    return null;
  }
}

/**
 * Charge les LeadContacts avec feedback reçu sur les N derniers jours.
 *
 * @param {Object} [opts]
 * @param {number} [opts.lookbackDays]  Défaut 7
 * @param {Object} [opts.client]        Injection tests
 * @param {Date}   [opts.now]
 * @returns {Promise<LeadContactRow[]>}
 */
async function loadRecentFeedback(opts = {}) {
  const client = opts.client || getLeadContactsClient();
  if (!client) return [];
  const lookbackDays = Number.isFinite(opts.lookbackDays) ? opts.lookbackDays : DEFAULT_LOOKBACK_DAYS;
  const now = opts.now || new Date();
  const cutoff = new Date(now.getTime() - lookbackDays * 24 * 3600 * 1000).toISOString();

  const out = [];
  try {
    const iterator = client.listEntities({
      queryOptions: {
        filter: `feedbackAt ge '${cutoff}'`,
      },
    });
    for await (const entity of iterator) {
      out.push(entity);
      if (out.length >= 50_000) break; // garde-fou
    }
  } catch {
    return out;
  }
  return out;
}

/**
 * Applique des updates EmailPatternRow sur la table `EmailPatterns`.
 * Lecture row existante + merge par `mergeWithExisting` → upsert.
 *
 * @param {Map|Array} bucketsOrUpdates  Bucket agrégats OU updates déjà calculés
 * @param {Object}    [opts]
 * @param {Object}    [opts.client]     TableClient injectable
 * @returns {Promise<{ updated:number, created:number, deactivated:number, errors:number }>}
 */
async function applyPatternUpdates(bucketsOrUpdates, opts = {}) {
  const client = opts.client || getEmailPatternsClient();
  const stats = { updated: 0, created: 0, deactivated: 0, errors: 0, deactivatedKeys: [] };
  if (!client) return stats;

  const buckets = bucketsOrUpdates instanceof Map
    ? [...bucketsOrUpdates.values()]
    : (Array.isArray(bucketsOrUpdates) ? bucketsOrUpdates : []);

  try {
    await client.createTable();
  } catch {
    // exists or other error — swallow
  }

  for (const bucket of buckets) {
    const partitionKey = bucket.nafDivision || '_';
    const rowKey = `${bucket.tranche || '_'}_${bucket.patternId}`;
    let existing = null;
    try {
      existing = await client.getEntity(partitionKey, rowKey);
    } catch (err) {
      const code = err && (err.statusCode || (err.response && err.response.status));
      if (code !== 404) {
        stats.errors++;
        continue;
      }
    }

    const merged = mergeWithExisting(bucket, existing);
    const wasActive = !existing || existing.active !== false;
    const nowActive = merged.active !== false;
    const justDeactivated = wasActive && !nowActive;

    try {
      await client.upsertEntity({
        partitionKey,
        rowKey,
        ...merged,
      }, 'Merge');
      if (existing) stats.updated++;
      else stats.created++;
      if (justDeactivated) {
        stats.deactivated++;
        stats.deactivatedKeys.push(`${partitionKey}/${rowKey}`);
      }
    } catch {
      stats.errors++;
    }
  }
  return stats;
}

/**
 * Pipeline complet : load → aggregate → apply. Utilisé par le Timer.
 *
 * @param {Object} [opts]  Injectable pour tests
 * @returns {Promise<{ rowsScanned, bucketsFound, updated, created, deactivated, errors, elapsedMs }>}
 */
async function runWeeklyLearn(opts = {}) {
  const started = Date.now();
  const rows = await loadRecentFeedback(opts);
  const buckets = aggregateRows(rows);
  const stats = await applyPatternUpdates(buckets, opts);
  return {
    rowsScanned: rows.length,
    bucketsFound: buckets.size,
    ...stats,
    elapsedMs: Date.now() - started,
  };
}

function _resetForTests() {
  _leadContactsClient = null;
  _emailPatternsClient = null;
}

module.exports = {
  extractPatternIdFromSignals,
  classifyFeedback,
  nafDivisionOf,
  aggregateRows,
  mergeWithExisting,
  shouldDeactivate,
  loadRecentFeedback,
  applyPatternUpdates,
  runWeeklyLearn,
  _resetForTests,
  _constants: {
    BOUNCE_RATE_DEACTIVATION_THRESHOLD,
    MIN_SAMPLE_SIZE_FOR_DEACTIVATION,
    DEFAULT_LOOKBACK_DAYS,
  },
};
