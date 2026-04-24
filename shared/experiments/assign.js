'use strict';

/**
 * Assignment déterministe et stateless pour A/B testing.
 *
 * Propriétés (SPEC_AB_TESTING §2) :
 *   - Déterministe : même entity_id + même experiment_id → même variante
 *   - Stateless : pas de DB d'assignments, hash SHA-256(expId:entityId) mod totalWeight
 *   - Respecte les poids des variantes (weight entier > 0)
 *
 * Usage typique :
 *   const variant = assignVariant('mail_personalisation', siren, [
 *     { id: 'control', weight: 1 },
 *     { id: 'personalized', weight: 1 },
 *   ]);
 *
 * Pure function, aucun I/O.
 */

const crypto = require('crypto');

/**
 * @param {string} experimentId    Identifiant stable de l'expérience.
 * @param {string} entityId        Identifiant stable de l'entité (ex. siren).
 * @param {Array<{id:string, weight?:number}>} variants
 * @returns {string}               L'id de la variante assignée.
 */
function assignVariant(experimentId, entityId, variants) {
  if (!Array.isArray(variants) || variants.length === 0) {
    throw new Error('assignVariant: variants must be a non-empty array');
  }
  if (!experimentId || typeof experimentId !== 'string') {
    throw new Error('assignVariant: experimentId required');
  }
  if (entityId === undefined || entityId === null || entityId === '') {
    throw new Error('assignVariant: entityId required');
  }

  // Filtre les variantes avec weight 0 ou négatif (considérées inactives)
  const active = variants.filter((v) => v && v.id && normalizeWeight(v.weight) > 0);
  if (active.length === 0) {
    // Toutes les variantes à weight 0 : cas pathologique, on retourne
    // déterministiquement la première id fournie
    return variants[0].id;
  }
  if (active.length === 1) return active[0].id;

  const totalWeight = active.reduce((sum, v) => sum + normalizeWeight(v.weight), 0);
  const hash = crypto.createHash('sha256')
    .update(`${experimentId}:${entityId}`)
    .digest();
  // 4 premiers octets → uint32 big-endian → modulo totalWeight
  const bucket = hash.readUInt32BE(0) % totalWeight;

  let acc = 0;
  for (const variant of active) {
    acc += normalizeWeight(variant.weight);
    if (bucket < acc) return variant.id;
  }
  // Fallback impossible en théorie (bucket < totalWeight garanti)
  return active[active.length - 1].id;
}

function normalizeWeight(w) {
  if (w === undefined || w === null) return 1;
  const n = Number(w);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

module.exports = {
  assignVariant,
  // exposé pour tests :
  _internals: { normalizeWeight },
};
