/**
 * Tests unitaires — sortByDistanceDesc + computeZoneCenter.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  sortByDistanceDesc,
  computeZoneCenter,
} = require('../../../shared/leadSelector');
const { CENTRE_FRANCE_METROPOLITAINE, departementCentroid } = require('../../../shared/geocoding');

const PARIS = { lat: 48.86, lon: 2.35 };
const LYON = { lat: 45.76, lon: 4.83 };
const MARSEILLE = { lat: 43.30, lon: 5.40 };
const STRASBOURG = { lat: 48.58, lon: 7.75 };

function entity(siren, ville, point) {
  return point
    ? { siren, ville, latitude: point.lat, longitude: point.lon }
    : { siren, ville };
}

// ─── sortByDistanceDesc ─────────────────────────────────────────────────────

test('sortByDistanceDesc — center=Paris : Marseille avant Lyon avant Versailles', () => {
  const entities = [
    entity('1-versailles', 'Versailles', { lat: 48.80, lon: 2.13 }),
    entity('2-lyon', 'Lyon', LYON),
    entity('3-marseille', 'Marseille', MARSEILLE),
    entity('4-strasbourg', 'Strasbourg', STRASBOURG),
  ];
  const sorted = sortByDistanceDesc(entities, PARIS);
  assert.equal(sorted[0].siren, '3-marseille'); // ~660 km
  assert.equal(sorted[1].siren, '4-strasbourg'); // ~400 km
  assert.equal(sorted[2].siren, '2-lyon'); // ~390 km
  assert.equal(sorted[3].siren, '1-versailles'); // ~15 km
});

test('sortByDistanceDesc — entités sans GPS placées en queue, tri alphabétique sur ville', () => {
  const entities = [
    entity('1', 'Lyon', LYON),
    entity('2', 'Bordeaux'), // pas de GPS
    entity('3', 'Marseille', MARSEILLE),
    entity('4', 'Antibes'), // pas de GPS
  ];
  const sorted = sortByDistanceDesc(entities, PARIS);
  // Les 2 premiers ont GPS, triés par distance desc
  assert.ok(sorted[0].latitude !== undefined);
  assert.ok(sorted[1].latitude !== undefined);
  // Les 2 derniers sans GPS, triés alphabétiquement (Antibes avant Bordeaux)
  assert.equal(sorted[2].ville, 'Antibes');
  assert.equal(sorted[3].ville, 'Bordeaux');
});

test('sortByDistanceDesc — entités avec lat/lon strings (cas LeadBase)', () => {
  // Azure Tables peut renvoyer des nombres en strings
  const entities = [
    { siren: 'a', ville: 'Lille', latitude: '50.63', longitude: '3.07' },
    { siren: 'b', ville: 'Nice', latitude: '43.70', longitude: '7.27' },
  ];
  const sorted = sortByDistanceDesc(entities, PARIS);
  // Nice plus loin de Paris que Lille
  assert.equal(sorted[0].siren, 'b');
  assert.equal(sorted[1].siren, 'a');
});

test('sortByDistanceDesc — center=centre France : équilibré (les extrêmes en tête)', () => {
  const entities = [
    entity('1', 'Paris', PARIS),
    entity('2', 'Marseille', MARSEILLE),
    entity('3', 'Strasbourg', STRASBOURG),
    entity('4', 'Lyon', LYON),
  ];
  const sorted = sortByDistanceDesc(entities, CENTRE_FRANCE_METROPOLITAINE);
  // Lyon est ~250 km du centre France, Strasbourg ~430 km
  // Strasbourg doit arriver avant Lyon
  const idxStr = sorted.findIndex((e) => e.siren === '3');
  const idxLyon = sorted.findIndex((e) => e.siren === '4');
  assert.ok(idxStr < idxLyon);
});

test('sortByDistanceDesc — array vide → []', () => {
  assert.deepEqual(sortByDistanceDesc([], PARIS), []);
});

test('sortByDistanceDesc — toutes entités sans GPS → tri alphabétique', () => {
  const entities = [entity('1', 'Zermatt'), entity('2', 'Annecy'), entity('3', 'Lyon')];
  const sorted = sortByDistanceDesc(entities, PARIS);
  assert.deepEqual(sorted.map((e) => e.ville), ['Annecy', 'Lyon', 'Zermatt']);
});

// ─── computeZoneCenter ──────────────────────────────────────────────────────

test('computeZoneCenter — zone=france → centre France', async () => {
  const c = await computeZoneCenter({ zone: 'france' });
  assert.equal(c.lat, CENTRE_FRANCE_METROPOLITAINE.lat);
  assert.equal(c.lon, CENTRE_FRANCE_METROPOLITAINE.lon);
  assert.equal(c.source, 'centre_france');
});

test('computeZoneCenter — adresse géocodable via injection', async () => {
  const fakeGeocode = async (addr) => {
    if (addr.includes('Paris')) return { lat: 48.85, lon: 2.34, source: 'nominatim' };
    return null;
  };
  const c = await computeZoneCenter(
    { zone: 'adresse', adresse: '10 rue Réaumur, 75003 Paris' },
    { geocode: fakeGeocode },
  );
  assert.equal(c.lat, 48.85);
  assert.equal(c.source, 'nominatim');
});

test('computeZoneCenter — adresse non géocodable → fallback département via CP', async () => {
  const failingGeocode = async () => null;
  const c = await computeZoneCenter(
    { zone: 'adresse', ville: '69001 Lyon' },
    { geocode: failingGeocode },
  );
  // Doit retomber sur le centroïde du dep 69
  const expected = departementCentroid('69');
  assert.equal(c.lat, expected.lat);
  assert.equal(c.lon, expected.lon);
  assert.match(c.source, /centroid_69/);
});

test('computeZoneCenter — rien d\'exploitable → centre France fallback', async () => {
  const failingGeocode = async () => null;
  const c = await computeZoneCenter({ zone: 'adresse' }, { geocode: failingGeocode });
  assert.equal(c.lat, CENTRE_FRANCE_METROPOLITAINE.lat);
  assert.match(c.source, /fallback/);
});
