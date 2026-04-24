'use strict';

/**
 * Interface `EmailExternalAdapter` — contrat des providers externes
 * de résolution email (Dropcontact en V1, potentiels autres en V2).
 *
 * Tout adapter consommé par shared/lead-exhauster doit exposer :
 *   - { string }  name            — identifiant stable (ex. "dropcontact")
 *   - { boolean } enabled         — flag statique lu au constructeur
 *   - { Function } resolve(input) — async, retourne ResolveResult
 *
 * Les adapters gèrent eux-mêmes timeout, retry interne, auth, mapping
 * qualification provider → confidence 0-1. L'orchestrateur leur passe un
 * payload normalisé, agrège le résultat et applique la politique budget
 * / circuit breaker côté lead-exhauster (pas côté adapter).
 */

/**
 * @typedef {Object} ResolveInput
 * @property {string}  firstName       Prénom décideur.
 * @property {string}  lastName        Nom décideur.
 * @property {string}  companyName     Raison sociale.
 * @property {string}  [companyDomain] Domaine si déjà résolu (évite lookup côté provider).
 * @property {string}  siren           9 chiffres.
 * @property {number}  [timeoutMs]     Override timeout par appel.
 */

/**
 * @typedef {Object} ResolveResult
 * @property {string|null} email           Email résolu, ou null si non trouvé.
 * @property {number}      confidence      0-1. Provider-spécifique, mappé par l'adapter.
 * @property {number}      cost_cents      Coût de l'appel (0 si pay-on-success et pas trouvé).
 * @property {Object}      providerRaw     Payload brut pour audit / debug.
 * @property {string}      [qualification] Libellé qualification natif provider (optionnel).
 * @property {Error}       [error]         Erreur remontée par le provider (optionnelle).
 */

/**
 * @typedef {Object} EmailExternalAdapter
 * @property {string}  name
 * @property {boolean} enabled
 * @property {(input: ResolveInput) => Promise<ResolveResult>} resolve
 */

/**
 * Valide qu'un objet respecte le contrat EmailExternalAdapter.
 * Utilisé par l'orchestrateur au câblage + par les tests pour détecter
 * les régressions de signature.
 *
 * @param {*} adapter
 * @returns {{ ok: boolean, errors: string[] }}
 */
function validateAdapter(adapter) {
  const errors = [];
  if (!adapter || typeof adapter !== 'object') {
    return { ok: false, errors: ['adapter is null or not an object'] };
  }
  if (typeof adapter.name !== 'string' || !adapter.name) {
    errors.push('adapter.name must be a non-empty string');
  }
  if (typeof adapter.enabled !== 'boolean') {
    errors.push('adapter.enabled must be a boolean');
  }
  if (typeof adapter.resolve !== 'function') {
    errors.push('adapter.resolve must be a function');
  }
  return { ok: errors.length === 0, errors };
}

module.exports = {
  validateAdapter,
};
