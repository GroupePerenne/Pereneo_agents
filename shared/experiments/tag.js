'use strict';

/**
 * Helpers de tagging — construit le contexte A/B passé au pipeline
 * (leadExhauster, profileProspect, runSequence).
 *
 * Contrat ExperimentsContext (SPEC_AB_TESTING §4.2) :
 *   {
 *     applied: [{ experiment_id, variant, type }, ...],
 *     shouldApplyVariant(experiment_id, variant_id) → boolean
 *   }
 *
 * `applied` est une photographie du moment où le contexte est construit.
 * Les consommateurs aval l'enregistrent dans leurs traces (LeadContacts,
 * Interactions) pour permettre la jointure au rapport §6.
 */

const { getActiveExperiments } = require('./registry');
const { assignVariant } = require('./assign');

/**
 * Construit le contexte A/B pour une entité donnée.
 *
 * @param {Object} entity
 * @param {string} entity.siren            Utilisé comme entityId hash
 * @param {string} [entity.beneficiaryId]
 * @param {string} [entity.naf]
 * @param {string} [entity.tranche]
 * @param {string} [entity.type]           Filtre type expérience (ex. 'lead_enrichment')
 * @param {Object} [opts]                  Propagé à getActiveExperiments
 * @returns {Promise<ExperimentsContext>}
 */
async function buildExperimentsContext(entity = {}, opts = {}) {
  const experiments = await getActiveExperiments(
    {
      type: entity.type,
      beneficiaryId: entity.beneficiaryId,
      naf: entity.naf,
      tranche: entity.tranche,
    },
    opts,
  );

  const applied = [];
  const entityId = String(entity.siren || entity.entityId || '');
  if (entityId) {
    for (const exp of experiments) {
      try {
        const variant = assignVariant(exp.experiment_id, entityId, exp.variants);
        applied.push({
          experiment_id: exp.experiment_id,
          variant,
          type: exp.type,
        });
      } catch {
        // Expérience mal-formée ignorée silencieusement — le filtrage
        // hydrateExperiment a déjà passé, donc ne devrait pas arriver.
      }
    }
  }

  return wrapContext(applied);
}

/**
 * Emballe une liste d'applied en ExperimentsContext avec l'API helper.
 * Exposé pour les tests et pour les cas où un contexte est reconstitué
 * depuis une source externe (trace, rejouable).
 */
function wrapContext(applied) {
  const list = Array.isArray(applied) ? applied : [];
  return {
    applied: list,
    shouldApplyVariant(experimentId, variantId) {
      for (const a of list) {
        if (a.experiment_id === experimentId && a.variant === variantId) {
          return true;
        }
      }
      return false;
    },
  };
}

/**
 * Context vide — utilisé par les consommateurs qui n'ont pas de source
 * A/B disponible (tests, fallback).
 */
function emptyContext() {
  return wrapContext([]);
}

module.exports = {
  buildExperimentsContext,
  wrapContext,
  emptyContext,
};
