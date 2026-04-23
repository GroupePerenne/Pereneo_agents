'use strict';

/**
 * Lead Exhauster — squelette orchestrateur public (Jalon 1).
 *
 * Responsabilité : à partir d'un SIREN (+ éventuelles infos optionnelles),
 * produire un `LeadContacts` exploitable par le pipeline aval (Graph Mail
 * via runSequence), avec une confidence ≥ seuil tenant (défaut 0.80).
 *
 * État au Jalon 1 :
 *   - Interface publique définie et gelée (voir LeadExhausterInput / Output
 *     dans shared/lead-exhauster/schemas.js)
 *   - Pipeline câblé :
 *       étape 0 : lookup cache LeadContacts
 *       étape 1 : resolveDomain (complet)
 *       étape 2 : résolution décideur → STUB (Jalon 2)
 *       étape 3 : résolution email → STUB (Jalon 2)
 *       étape 4 : cascade Dropcontact → STUB (adapter squelette Jalon 3)
 *       étape 5 : trace LeadContacts (complet)
 *   - reportFeedback() câblé via trace.updateFeedback (utilisable par
 *     runSequence dès maintenant pour ne pas bloquer le chantier profiler)
 *
 * Au sortir du Jalon 1, leadExhauster() retourne :
 *   - cache hit si LeadContacts contient déjà une résolution fraîche
 *   - domaine + status='unresolvable' sinon (les étapes 2-4 arrivent aux
 *     Jalons suivants)
 *
 * Ce design permet de câbler runLeadSelectorForConsultant au Jalon 3 avec
 * une interface publique déjà figée, sans refactor.
 *
 * SPEC : SPEC_LEAD_EXHAUSTER_v1_0.md §3 (pipeline) + §3.2 (interface)
 */

const { resolveDomain } = require('./resolveDomain');
const { readLeadContact, upsertLeadContact, updateFeedback } = require('./trace');
const { DEFAULT_CONFIDENCE_THRESHOLD, SOURCES, STATUS } = require('./schemas');
const { normalizeNamePart } = require('./patterns');

const DEFAULT_CACHE_TTL_DAYS = 90;

/**
 * Orchestrateur principal. Retourne toujours un LeadExhausterOutput
 * (jamais throw en production — même en cas d'erreur interne, status='error').
 *
 * @param {import('./schemas').LeadExhausterInput} input
 * @param {Object} [opts]
 * @param {Function|Object} [opts.logger]
 * @param {Object} [opts.adapters]   Override pour tests (cache, dropcontact…)
 * @returns {Promise<import('./schemas').LeadExhausterOutput>}
 */
async function leadExhauster(input = {}, opts = {}) {
  const started = Date.now();
  const logger = opts.logger || null;

  // Validation d'entrée
  if (!input.siren || !/^\d{9}$/.test(String(input.siren))) {
    return buildOutput({
      status: STATUS.ERROR,
      signals: ['invalid_siren'],
      elapsedMs: Date.now() - started,
    });
  }
  if (!input.beneficiaryId) {
    return buildOutput({
      status: STATUS.ERROR,
      signals: ['missing_beneficiary_id'],
      elapsedMs: Date.now() - started,
    });
  }

  const threshold = Number.isFinite(input.confidenceThreshold)
    ? input.confidenceThreshold
    : DEFAULT_CONFIDENCE_THRESHOLD;
  const experimentsApplied = extractAppliedExperiments(input.experimentsContext);
  const signals = [];

  // ─── Étape 0 : lookup cache ──────────────────────────────────────────────
  const cacheReader = (opts.adapters && opts.adapters.readLeadContact) || readLeadContact;
  const cached = await cacheReader({
    siren: input.siren,
    firstName: input.firstName,
    lastName: input.lastName,
  }).catch(() => null);
  if (cached && isFreshCacheHit(cached)) {
    log(logger, 'info', 'exhauster.cache.hit', { siren: input.siren });
    return buildOutput({
      status: cached.email ? STATUS.OK : STATUS.UNRESOLVABLE,
      email: cached.email,
      confidence: Number(cached.confidence) || 0,
      source: SOURCES.CACHE,
      signals: [`cache_hit_from_${cached.source}`],
      cost_cents: 0,
      resolvedDecisionMaker: cached.firstName
        ? {
            firstName: cached.firstName,
            lastName: cached.lastName,
            role: cached.role || '',
            source: cached.roleSource || 'insee',
            confidence: Number(cached.roleConfidence) || 0,
          }
        : null,
      resolvedDomain: cached.domain || null,
      cached: true,
      elapsedMs: Date.now() - started,
      experimentsApplied,
    });
  }

  // ─── Étape 1 : résolution domaine ────────────────────────────────────────
  const domainResult = await resolveDomain(
    {
      siren: input.siren,
      companyName: input.companyName,
      companyDomain: input.companyDomain,
    },
    { logger, timeoutMs: opts.timeoutMs },
  ).catch((err) => {
    log(logger, 'warn', 'exhauster.resolveDomain.error', { err: err && err.message });
    return { domain: null, confidence: 0, source: 'none', signals: ['resolve_domain_error'], elapsedMs: 0 };
  });
  signals.push(...(domainResult.signals || []).map((s) => `domain.${s}`));

  // ─── Étape 2 (Jalon 2) : résolution décideur ────────────────────────────
  // Pour l'instant on reprend les firstName/lastName fournis par le caller
  // tels quels. Au Jalon 2, resolveDecisionMaker rescore INSEE vs scrapé
  // pour les PME 20-49 et +, et surcharge ces valeurs si signal fort.
  const decisionMaker = input.firstName || input.lastName
    ? {
        firstName: normalizeNamePart(input.firstName) || '',
        lastName: normalizeNamePart(input.lastName) || '',
        role: 'unknown',
        source: 'insee',
        confidence: 0.5,
      }
    : null;
  if (!decisionMaker) signals.push('decision_maker.missing_input');

  // ─── Étapes 3-4 (Jalons 2-3) : résolution email ──────────────────────────
  // Stub Jalon 1 : aucune résolution. Unresolvable si on arrive ici.
  signals.push('email_resolution.not_implemented_jalon_1');

  const output = buildOutput({
    status: STATUS.UNRESOLVABLE,
    email: null,
    confidence: 0,
    source: 'none',
    signals,
    cost_cents: 0,
    resolvedDecisionMaker: decisionMaker,
    resolvedDomain: domainResult.domain,
    cached: false,
    elapsedMs: Date.now() - started,
    experimentsApplied,
    simulated: Boolean(input.simulated),
  });

  // ─── Étape 5 : trace LeadContacts ───────────────────────────────────────
  // Best effort : on persiste même un unresolvable pour :
  //   (a) alimenter EmailUnresolvable via enqueue côté caller,
  //   (b) éviter de re-tenter à chaque demande avant re-résolution (TTL 90j),
  //   (c) préserver les signaux pour audit.
  const tracer = (opts.adapters && opts.adapters.upsertLeadContact) || upsertLeadContact;
  await Promise.resolve(
    tracer({
      siren: input.siren,
      email: null,
      confidence: 0,
      source: 'none',
      signals,
      cost_cents: 0,
      firstName: decisionMaker ? decisionMaker.firstName : '',
      lastName: decisionMaker ? decisionMaker.lastName : '',
      role: decisionMaker ? decisionMaker.role : '',
      roleSource: decisionMaker ? decisionMaker.source : '',
      roleConfidence: decisionMaker ? decisionMaker.confidence : 0,
      domain: domainResult.domain,
      domainSource: domainResult.source,
      experimentsApplied,
      beneficiaryId: input.beneficiaryId,
    }),
  ).catch(() => {});

  // Garde-fou seuil : même logique qu'au Jalon 3 (l'output reste
  // unresolvable si confidence < threshold). Ici confidence=0 donc OK.
  if (output.email && output.confidence < threshold) {
    output.status = STATUS.UNRESOLVABLE;
    output.signals.push(`confidence_below_threshold_${threshold}`);
  }
  return output;
}

/**
 * Hook feedback pour runSequence / davidInbox.
 * Fire-and-forget côté caller — ce module absorbe toute erreur.
 *
 *   await leadExhauster.reportFeedback({
 *     siren: '123456789',
 *     firstName: 'Jean',
 *     lastName: 'Dupont',
 *     status: 'delivered' | 'bounced' | 'replied' | 'spam_flagged',
 *     timestamp: ISOString,
 *   });
 *
 * @param {Object} p
 * @returns {Promise<boolean>}
 */
async function reportFeedback(p = {}) {
  try {
    return await updateFeedback(p);
  } catch {
    return false;
  }
}

// ─── Helpers internes ──────────────────────────────────────────────────────

function buildOutput(partial = {}) {
  return {
    status: partial.status || STATUS.ERROR,
    email: partial.email || null,
    confidence: typeof partial.confidence === 'number' ? partial.confidence : 0,
    source: partial.source || 'none',
    signals: Array.isArray(partial.signals) ? partial.signals.slice() : [],
    cost_cents: Number.isFinite(partial.cost_cents) ? partial.cost_cents : 0,
    resolvedDecisionMaker: partial.resolvedDecisionMaker || null,
    resolvedDomain: partial.resolvedDomain || null,
    cached: Boolean(partial.cached),
    elapsedMs: Number.isFinite(partial.elapsedMs) ? partial.elapsedMs : 0,
    experimentsApplied: Array.isArray(partial.experimentsApplied)
      ? partial.experimentsApplied
      : [],
    ...(partial.simulated !== undefined ? { simulated: Boolean(partial.simulated) } : {}),
  };
}

function isFreshCacheHit(row) {
  if (!row || !row.lastVerifiedAt) return false;
  const last = Date.parse(row.lastVerifiedAt);
  if (!Number.isFinite(last)) return false;
  const ageDays = (Date.now() - last) / (24 * 3600 * 1000);
  return ageDays <= DEFAULT_CACHE_TTL_DAYS;
}

function extractAppliedExperiments(ctx) {
  if (!ctx || !Array.isArray(ctx.applied)) return [];
  return ctx.applied
    .filter((a) => a && a.experiment_id && a.variant)
    .map((a) => `${a.experiment_id}:${a.variant}`);
}

function log(logger, level, message, payload) {
  if (!logger) return;
  if (typeof logger[level] === 'function') logger[level](message, payload);
  else if (typeof logger === 'function') logger(`${level}: ${message}`, payload);
  else if (typeof logger.log === 'function') logger.log(`[${level}] ${message}`, payload);
}

// ─── Exports ───────────────────────────────────────────────────────────────

leadExhauster.reportFeedback = reportFeedback;

module.exports = {
  leadExhauster,
  reportFeedback,
  // Exposés pour tests / sous-modules :
  _internals: { buildOutput, isFreshCacheHit, extractAppliedExperiments, DEFAULT_CACHE_TTL_DAYS },
};
