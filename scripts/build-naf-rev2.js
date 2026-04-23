#!/usr/bin/env node
/**
 * scripts/build-naf-rev2.js
 *
 * Génère `forms/data/naf-rev2.json` à partir du package officiel
 * `@socialgouv/codes-naf` (nomenclature NAF rév. 2 de l'INSEE, maintenu par
 * la Fabrique Sociale du gouvernement français, licence Apache 2.0).
 *
 * Le fichier généré contient les 732 sous-classes (niveau le plus fin,
 * format XX.XXA/XX.XXZ) — c'est le niveau utilisé par l'INSEE pour le
 * `codeNafPrincipal` des SIREN, donc aligné avec ce qui est stocké dans
 * la LeadBase. Chaque entrée est enrichie avec sa division (2 premiers
 * chiffres) et le libellé de cette division, utile pour regrouper les
 * suggestions dans le composant autocomplete du formulaire consultant
 * (`forms/formulaire-oseys.html`).
 *
 * Usage (depuis la racine du repo) :
 *   npm install                         # installe @socialgouv/codes-naf (devDep)
 *   node scripts/build-naf-rev2.js      # (re)génère forms/data/naf-rev2.json
 *
 * Relancer ce script uniquement si la nomenclature NAF évolue (le passage
 * NAF 2008 rév. 2 → NAF 2025 est prévu par l'INSEE). Un bump de version
 * du package suffit pour récupérer la nouvelle nomenclature.
 *
 * @see https://www.npmjs.com/package/@socialgouv/codes-naf
 */

'use strict';

const fs = require('fs');
const path = require('path');

const source = require('@socialgouv/codes-naf');

// 1. Garder uniquement les sous-classes (niveau INSEE le plus fin).
const sousClasses = source.filter((e) => /^\d{2}\.\d{2}[A-Z]$/.test(e.id));

// 2. Construire la table des libellés de divisions pour enrichissement.
const divisionLabels = {};
source
  .filter((e) => /^\d{2}$/.test(e.id))
  .forEach((e) => {
    divisionLabels[e.id] = e.label;
  });

// 3. Projeter chaque sous-classe dans le schéma consommé par le formulaire.
const result = sousClasses
  .map((e) => ({
    code: e.id,
    libelle: e.label,
    division: e.id.substring(0, 2),
    divisionLibelle: divisionLabels[e.id.substring(0, 2)] || null,
  }))
  .sort((a, b) => a.code.localeCompare(b.code));

// 4. Écriture.
const outPath = path.join(__dirname, '..', 'forms', 'data', 'naf-rev2.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(result, null, 2));

const sizeKo = (fs.statSync(outPath).size / 1024).toFixed(1);
console.log(`[naf-rev2] ${result.length} sous-classes écrites dans ${outPath} (${sizeKo} Ko)`);
