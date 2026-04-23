'use strict';

/**
 * Adapter Dropcontact — cascade externe de résolution email.
 *
 * Décision Paul : Dropcontact > Hunter pour le pilote OSEYS (match rate
 * 55% vs 33%, bounce 0.9% vs 11.2%, souveraineté FR/RGPD). Budget V1 =
 * 24€/mois sur le plan Starter 1000 crédits. Pay-on-success : pas de
 * coût facturé si email non trouvé (cost_cents=0 dans ce cas).
 *
 * Portée Jalon 1 (ce fichier) :
 *   - Squelette conforme à `EmailExternalAdapter`
 *   - Mapping qualification Dropcontact → confidence 0-1 (table figée V1)
 *   - Validation d'entrée minimale (firstName/lastName/companyName)
 *   - resolve() fait un stub "not_implemented" tant que l'appel HTTP
 *     n'est pas câblé
 *
 * Portée Jalon 3 (à compléter ici-même) :
 *   - Appel HTTP batch (`POST /batch`) avec timeout 15s
 *   - Budget check avant appel (lecture table Budgets)
 *   - Circuit breaker 10 min après 3 échecs consécutifs
 *   - Comptabilité `cost_cents` (lecture réponse batch)
 *   - Respect du pay-on-success
 *
 * Le budget check et le circuit breaker vivent **côté orchestrateur**
 * plutôt que dans cet adapter (le driver est découplé de la policy pour
 * faciliter tests et migration provider). L'adapter ne fait QUE l'appel.
 */

const { validateAdapter } = require('./interface');

// ─── Mapping qualification Dropcontact → confidence (SPEC §5.3) ────────────
// Source : doc Dropcontact API + observation marché. Table figée V1, à
// surcharger seulement si Dropcontact introduit de nouvelles qualifications
// ou si nos relevés post-Jalon 4 montrent une dérive > 10% sur un bucket.
const QUALIFICATION_MAP = Object.freeze({
  nominative_verified: 0.98,
  nominative: 0.95,
  catch_all: 0.50,
  role: 0.30,
});

const DEFAULT_API_URL = 'https://api.dropcontact.io/batch';
const DEFAULT_TIMEOUT_MS = 15000;

class DropcontactAdapter {
  /**
   * @param {Object} [opts]
   * @param {string}  [opts.apiKey]     Défaut process.env.DROPCONTACT_API_KEY
   * @param {string}  [opts.apiUrl]     Défaut process.env.DROPCONTACT_API_URL ou DEFAULT_API_URL
   * @param {boolean} [opts.enabled]    Défaut process.env.DROPCONTACT_ENABLED === 'true'
   * @param {number}  [opts.timeoutMs]  Timeout HTTP (défaut 15s)
   * @param {Function}[opts.fetchImpl]  Injection pour tests
   * @param {Function|Object} [opts.logger] context.log ou {info,warn,error}
   */
  constructor(opts = {}) {
    this.name = 'dropcontact';
    this.apiKey = opts.apiKey || process.env.DROPCONTACT_API_KEY || '';
    this.apiUrl = opts.apiUrl || process.env.DROPCONTACT_API_URL || DEFAULT_API_URL;
    const envEnabled = process.env.DROPCONTACT_ENABLED === 'true'
      || process.env.DROPCONTACT_ENABLED === '1';
    this.enabled = typeof opts.enabled === 'boolean' ? opts.enabled : envEnabled;
    this.timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
    this._fetch = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    this._logger = opts.logger || null;

    // Si activé sans apiKey → échec à construction, pas au premier appel
    // (principe "fail fast"). En staging/test, laisser DROPCONTACT_ENABLED=false.
    if (this.enabled && !this.apiKey) {
      throw new Error('DropcontactAdapter: enabled=true mais apiKey manquante');
    }
  }

  /**
   * Mapping brut qualification → confidence. Exposé statiquement pour tests
   * et pour le lookup direct sans instancier l'adapter.
   * Qualification inconnue → 0 (confiance nulle, rejetée par l'orchestrateur).
   */
  static qualificationToConfidence(q) {
    if (!q || typeof q !== 'string') return 0;
    const key = q.toLowerCase().trim();
    const v = QUALIFICATION_MAP[key];
    return typeof v === 'number' ? v : 0;
  }

  /**
   * Validation minimale d'un ResolveInput. Retourne une liste d'erreurs
   * (vide = OK). Exposé pour tests.
   */
  static validateInput(input) {
    const errors = [];
    if (!input || typeof input !== 'object') return ['input is required'];
    if (!input.firstName || typeof input.firstName !== 'string') errors.push('firstName required');
    if (!input.lastName || typeof input.lastName !== 'string') errors.push('lastName required');
    if (!input.companyName && !input.companyDomain) {
      errors.push('companyName or companyDomain required');
    }
    if (!input.siren || !/^\d{9}$/.test(String(input.siren))) {
      errors.push('siren must be 9 digits');
    }
    return errors;
  }

  /**
   * Résout un email pour un décideur donné via Dropcontact.
   *
   * Jalon 1 : retourne un stub avec signal `not_implemented` si l'adapter
   * est désactivé ou si fetchImpl absent. L'orchestrateur traite ce cas
   * comme une absence de cascade (status='unresolvable' si seuil non atteint
   * avec les signaux internes).
   *
   * Jalon 3 : câblage réel batch POST + polling du résultat, mapping
   * qualification, calcul cost_cents.
   *
   * @param {import('./interface').ResolveInput} input
   * @returns {Promise<import('./interface').ResolveResult>}
   */
  async resolve(input) {
    const validationErrors = DropcontactAdapter.validateInput(input);
    if (validationErrors.length > 0) {
      return {
        email: null,
        confidence: 0,
        cost_cents: 0,
        providerRaw: { validation_errors: validationErrors },
        error: new Error(`dropcontact: invalid input: ${validationErrors.join(', ')}`),
      };
    }

    if (!this.enabled) {
      this._log('info', 'dropcontact.skip.disabled', { siren: input.siren });
      return {
        email: null,
        confidence: 0,
        cost_cents: 0,
        providerRaw: { skipped: 'disabled' },
      };
    }

    // Jalon 1 : stub. Jalon 3 remplacera ce bloc par l'appel HTTP réel.
    this._log('warn', 'dropcontact.stub.not_implemented', { siren: input.siren });
    return {
      email: null,
      confidence: 0,
      cost_cents: 0,
      providerRaw: { stub: 'not_implemented_jalon_1' },
    };
  }

  _log(level, message, payload) {
    if (!this._logger) return;
    const logger = this._logger;
    if (logger && typeof logger[level] === 'function') {
      logger[level](message, payload);
    } else if (typeof logger === 'function') {
      logger(`${level}: ${message}`, payload);
    } else if (logger && typeof logger.log === 'function') {
      logger.log(`[${level}] ${message}`, payload);
    }
  }
}

// Self-check au chargement : l'adapter doit respecter le contrat
// EmailExternalAdapter. On instancie un adapter désactivé (sans apiKey)
// juste pour la validation de forme. L'erreur est fatale — si elle saute
// on a introduit une régression de signature.
(function assertAdapterContract() {
  const dummy = new DropcontactAdapter({ enabled: false });
  const { ok, errors } = validateAdapter(dummy);
  if (!ok) {
    throw new Error(`DropcontactAdapter contract violation: ${errors.join('; ')}`);
  }
})();

module.exports = {
  DropcontactAdapter,
  QUALIFICATION_MAP,
};
