/**
 * Générateur de séquence de prospection J0 / J3 / J7 / J14
 *
 * Utilisé par Martin et Mila pour produire les 4 messages d'une séquence,
 * personnalisés au consultant, au lead et à l'agent expéditeur.
 *
 * Dépendance : ANTHROPIC_API_KEY en variable d'environnement
 */

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-20250514';

/** Calendrier canonique de la séquence */
const SCHEDULE = [
  { jour: 'J0',  offsetDays: 0,  role: 'ouverture',
    brief: 'Message d\'ouverture. Court (4-6 lignes). Une accroche naturelle liée au contexte métier du lead, une question simple qui invite à répondre. PAS de pitch commercial, PAS de présentation de l\'offre.' },
  { jour: 'J3',  offsetDays: 3,  role: 'relance_angle',
    brief: 'Relance. 3-5 lignes. Apporter un angle NOUVEAU par rapport au J0 (un constat, une observation sectorielle, une question différente). Surtout pas une redite du J0 avec "je reviens vers vous".' },
  { jour: 'J7',  offsetDays: 7,  role: 'valeur',
    brief: 'Message de valeur. 5-8 lignes. Partager une observation concrète, un insight, un cas client anonymisé. Donne de la matière sans demander quoi que ce soit. Terminer par une question ouverte.' },
  { jour: 'J14', offsetDays: 14, role: 'rupture',
    brief: 'Message de rupture poli. 3-4 lignes. Clôt gentiment la séquence, laisse la porte ouverte à un retour du lead plus tard. Pas de reproche, pas de culpabilisation.' },
];

/**
 * Génère les 4 messages d'une séquence complète.
 *
 * @param {Object} ctx
 * @param {Object} ctx.consultant  — { nom, offre, ton, tutoiement }
 * @param {Object} ctx.agent       — { prenom, mail, signature } (Martin ou Mila)
 * @param {Object} ctx.lead        — { prenom, nom, entreprise, secteur, ville, contexte }
 * @returns {Promise<Array>} tableau de 4 objets { jour, offsetDays, objet, corps }
 */
async function generateSequence({ consultant, agent, lead }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY non défini');

  const systemPrompt = buildSystemPrompt({ consultant, agent });
  const userPrompt = buildUserPrompt({ lead });

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${err}`);
  }
  const data = await res.json();
  const text = data.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const clean = text.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(clean);

  // On merge avec le schedule pour garantir jour/offsetDays corrects
  return SCHEDULE.map((s, i) => ({
    jour: s.jour,
    offsetDays: s.offsetDays,
    role: s.role,
    objet: parsed.steps[i].objet,
    corps: parsed.steps[i].corps,
  }));
}

function buildSystemPrompt({ consultant, agent }) {
  return `Tu es ${agent.prenom}, prospecteur(trice) commercial(e) au sein du réseau OSEYS. Tu écris au nom du consultant ${consultant.nom}.

OFFRE DU CONSULTANT : ${consultant.offre}

TON À RESPECTER :
- ${consultant.ton}
- ${consultant.tutoiement ? 'Tutoiement' : 'Vouvoiement'}
- Messages humains, courts, qui donnent envie de répondre
- JAMAIS de formules bateau ("j'espère que ce message vous trouve en forme", "suite à notre conversation", etc.)
- JAMAIS de "je reviens vers vous" en relance — apporte toujours un angle neuf

TU GÉNÈRES UNE SÉQUENCE DE 4 MESSAGES ESPACÉS COMME SUIT :
${SCHEDULE.map(s => `- ${s.jour} (J+${s.offsetDays}) — ${s.role.toUpperCase()} : ${s.brief}`).join('\n')}

RÈGLES ABSOLUES :
- Réponds UNIQUEMENT en JSON valide, aucun texte autour
- Format exact :
{
  "steps": [
    { "objet": "...", "corps": "..." },
    { "objet": "...", "corps": "..." },
    { "objet": "...", "corps": "..." },
    { "objet": "...", "corps": "..." }
  ]
}
- Chaque "corps" utilise \\n pour les sauts de ligne
- Ne mets PAS de signature dans le corps — elle est ajoutée automatiquement après
- Ne mets PAS de "Bonjour [Prénom]" générique — utilise vraiment le prénom du lead`;
}

function buildUserPrompt({ lead }) {
  return `LEAD À PROSPECTER :
- Prénom : ${lead.prenom}
- Nom : ${lead.nom || ''}
- Entreprise : ${lead.entreprise}
- Secteur : ${lead.secteur}
- Ville : ${lead.ville || ''}
- Contexte / signaux : ${lead.contexte || 'aucun signal particulier'}

Génère les 4 messages de la séquence. Sois naturel, pertinent, et accroche vraiment sur la réalité du métier et du contexte du lead.`;
}

/** Export du schedule pour que le scheduler puisse calculer les dates d'envoi */
module.exports = {
  generateSequence,
  SCHEDULE,
};
