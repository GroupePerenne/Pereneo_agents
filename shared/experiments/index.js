'use strict';

/**
 * Module A/B testing — API publique (SPEC_AB_TESTING §4.2).
 *
 * Composant transverse consommé par :
 *   - lead-exhauster (tagging `enrichment_method`)
 *   - prospect-profiler (tagging `mail_personalisation`)
 *   - runSequence (tagging `send_time`, `retry_cadence`)
 *   - experimentsReport (lecture groupée aval)
 *
 * Trois responsabilités distinctes :
 *   - `registry`  : lecture Azure Table Experiments + cache 5 min
 *   - `assign`    : fonction pure hash-based d'assignment variantes
 *   - `tag`       : helper qui combine les deux pour produire un
 *                   ExperimentsContext consommable par le pipeline
 *
 * Import depuis les consommateurs : `require('shared/experiments')`
 * (pas besoin d'importer les sous-modules directement sauf tests).
 */

const { assignVariant } = require('./assign');
const {
  loadActiveExperiments,
  getActiveExperiments,
  filterByContext,
  hydrateExperiment,
  DEFAULT_CACHE_TTL_MS,
  _resetForTests,
  _setClockForTests,
  _setCacheForTests,
} = require('./registry');
const { buildExperimentsContext, wrapContext, emptyContext } = require('./tag');

module.exports = {
  // API publique principale
  buildExperimentsContext,
  getActiveExperiments,
  assignVariant,
  // Helpers d'usage moins fréquent
  loadActiveExperiments,
  filterByContext,
  wrapContext,
  emptyContext,
  // Constantes + tests
  DEFAULT_CACHE_TTL_MS,
  hydrateExperiment,
  _resetForTests,
  _setClockForTests,
  _setCacheForTests,
};
