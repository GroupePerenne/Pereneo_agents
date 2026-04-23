'use strict';

/**
 * Orchestrateur public — prospect-profiler V0.
 *
 * Transforme un SIREN + email résolu en briefing d'approche structuré :
 *   - companyProfile (couche A) — fiche entreprise
 *   - decisionMakerProfile (couche B) — fiche décideur       [Jalon 2]
 *   - discScore — profil comportemental du décideur         [Jalon 2]
 *   - accroche — hook 2-3 phrases + angle d'entrée            [Jalon 2]
 *
 * Fallback gracieux :
 *   - Aucune source → status 'error', profile null
 *   - Une des couches échoue → status 'partial'
 *   - Les deux couches ok → status 'ok'
 *
 * Entrée Mem0 : à la fin d'un profileProspect, le payload est écrit
 *   via storeProspect(siren, profile) pour que runSequence.sendMail
 *   récupère automatiquement via resolveMem0Enrichments.         [Jalon 3]
 *
 * V0 Jalon 1 : seule la couche A est branchée. Les autres retournent null
 * tant que le Jalon 2 n'est pas livré. Le squelette fige le contrat
 * d'interface pour que les consommateurs downstream puissent déjà s'aligner.
 */

const { buildCompanyProfile } = require('./companyProfile');

// ─── API publique ──────────────────────────────────────────────────────────

/**
 * @param {object} input
 * @param {string} input.siren                     (requis)
 * @param {string} [input.firstName]
 * @param {string} [input.lastName]
 * @param {string} [input.role]
 * @param {string} [input.email]
 * @param {string} [input.companyName]
 * @param {string} [input.companyDomain]
 * @param {string} [input.companyLinkedInUrl]
 * @param {string} [input.decisionMakerLinkedInUrl]
 * @param {string} [input.beneficiaryId]
 * @param {object} [input.experimentsContext]       // consumed Jalon 3
 * @param {object} [opts]                            // overrides pour tests
 * @param {object} [opts.context]                    // Azure InvocationContext
 * @returns {Promise<ProfilerOutput>}
 */
async function profileProspect(input = {}, opts = {}) {
  const started = Date.now();
  const siren = String(input.siren || '').trim();

  if (!/^\d{9}$/.test(siren)) {
    return buildErrorOutput({
      siren,
      reason: 'invalid_siren',
      started,
    });
  }

  // Couche A — fiche entreprise
  const companyProfile = await buildCompanyProfile(
    {
      siren,
      companyName: input.companyName,
      companyDomain: input.companyDomain,
    },
    {
      context: opts.context,
      apiGouvImpl: opts.apiGouvImpl,
      scraperImpl: opts.scraperImpl,
      searchImpl: opts.searchImpl,
      llmImpl: opts.llmImpl,
      skipCache: opts.skipCache,
      timeoutMs: opts.companyTimeoutMs,
    },
  ).catch(() => null);

  // Couches B + pitch — placeholder Jalon 2
  const decisionMakerProfile = null;
  const accroche = null;

  const status = deriveStatus({ companyProfile, decisionMakerProfile });

  const costCents = (companyProfile && companyProfile.costCents) || 0;

  return {
    status,
    companyProfile: companyProfile || null,
    decisionMakerProfile,
    accroche,
    elapsedMs: Date.now() - started,
    cost_cents: costCents,
    experimentsApplied: extractExperimentsApplied(input),
    version: 'v0',
  };
}

/**
 * Status de l'output selon disponibilité des couches.
 *   - A null + B null   → 'error'
 *   - A ok + B null     → 'partial' (normal en V0 Jalon 1, Jalon 2 livre B)
 *   - A null + B ok     → 'partial'
 *   - A ok + B ok       → 'ok'
 */
function deriveStatus({ companyProfile, decisionMakerProfile }) {
  const hasA = !!companyProfile;
  const hasB = !!decisionMakerProfile;
  if (!hasA && !hasB) return 'error';
  if (hasA && hasB) return 'ok';
  return 'partial';
}

function extractExperimentsApplied(input) {
  const ctx = input && input.experimentsContext;
  if (!ctx || !Array.isArray(ctx.applied)) return [];
  return ctx.applied
    .filter((x) => x && typeof x.experiment_id === 'string' && typeof x.variant === 'string')
    .map((x) => ({ experiment_id: x.experiment_id, variant: x.variant }));
}

function buildErrorOutput({ siren, reason, started }) {
  return {
    status: 'error',
    companyProfile: null,
    decisionMakerProfile: null,
    accroche: null,
    elapsedMs: Date.now() - started,
    cost_cents: 0,
    experimentsApplied: [],
    version: 'v0',
    error: reason,
    siren,
  };
}

module.exports = {
  profileProspect,
  // Exposés pour tests uniquement
  _deriveStatus: deriveStatus,
  _extractExperimentsApplied: extractExperimentsApplied,
};
