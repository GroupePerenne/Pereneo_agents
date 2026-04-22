/**
 * Générateur de séquence de prospection J0 / J+4 / J+10 / J+18 / J+28
 *
 * Utilisé par Martin et Mila pour produire les 5 messages d'une séquence,
 * personnalisés au consultant, au lead et à l'agent expéditeur.
 *
 * Les offsets sont comptés en JOURS OUVRÉS français (cf. CLAUDE.md §1.7).
 * Le scheduling concret (weekend/jours fériés) est géré par shared/holidays.js.
 *
 * Dépendance : ANTHROPIC_API_KEY en variable d'environnement
 */

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';

/** Calendrier canonique de la séquence (5 touches sur 28 jours ouvrés) */
const SCHEDULE = [
  { jour: 'J0',   offsetBusinessDays: 0,  role: 'ouverture',
    brief: 'Message d\'ouverture. Court (4-6 lignes). Une accroche naturelle liée au contexte métier du lead, une question simple qui invite à répondre. PAS de pitch commercial, PAS de présentation de l\'offre.' },
  { jour: 'J+4',  offsetBusinessDays: 4,  role: 'relance_angle',
    brief: 'Relance avec angle NOUVEAU. 3-5 lignes. Apporter un constat, une observation sectorielle ou une question différente du J0. JAMAIS "je reviens vers vous" ou équivalent.' },
  { jour: 'J+10', offsetBusinessDays: 10, role: 'valeur',
    brief: 'Message de valeur. 5-8 lignes. Partager un insight concret, une observation métier utile, sans demander quoi que ce soit. Terminer par une question ouverte. Pas d\'invention de chiffres ou de cas clients non sourçables.' },
  { jour: 'J+18', offsetBusinessDays: 18, role: 'derniere_touche',
    brief: 'Dernière touche douce. 3-4 lignes. Ton léger, sans pression. Rappel court du sujet, invitation à réagir si le moment est opportun. Laisser le prospect maître de la suite.' },
  { jour: 'J+28', offsetBusinessDays: 28, role: 'rupture',
    brief: 'Rupture polie. 3-4 lignes. Annoncer qu\'on arrête de solliciter pour ne pas saturer, laisser la porte explicitement ouverte à un retour du prospect plus tard. Pas de reproche, pas de culpabilisation.' },
];

/**
 * Génère les 4 messages d'une séquence complète.
 *
 * @param {Object} ctx
 * @param {Object} ctx.consultant  — { nom, offre, ton, tutoiement }
 * @param {Object} ctx.agent       — { prenom, mail, signature } (Martin ou Mila)
 * @param {Object} ctx.lead        — { prenom, nom, entreprise, secteur, ville, contexte }
 * @param {Object} [ctx.enrichments] — { prospectMemories?, patternMemories? } (cf. Mem0 D2/D3)
 * @returns {Promise<Array>} tableau de 4 objets { jour, offsetDays, objet, corps }
 */
async function generateSequence({ consultant, agent, lead, enrichments }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY non défini');

  const systemPrompt = buildSystemPrompt({ consultant, agent });
  const userPrompt = buildUserPrompt({ lead, enrichments });

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

  // On merge avec le schedule pour garantir jour/offset corrects
  return SCHEDULE.map((s, i) => ({
    jour: s.jour,
    offsetBusinessDays: s.offsetBusinessDays,
    role: s.role,
    objet: parsed.steps[i].objet,
    corps: parsed.steps[i].corps,
  }));
}

function buildSystemPrompt({ consultant, agent }) {
  return `Tu es ${agent.prenom}, prospecteur(trice) commercial(e) au sein du réseau OSEYS. Tu écris au nom du consultant ${consultant.nom}.

RÈGLE D'HONNEUR (non négociable) :
- Tu n'inventes jamais un chiffre, un benchmark, un cas client, une référence d'entreprise, un nom. Si tu n'as pas la donnée, tu restes qualitatif ("on a l'habitude de voir", "certains consultants constatent") plutôt que chiffré.
- Tu ne promets jamais un résultat, un délai ou un taux de conversion. Tu décris ce que l'équipe fait, pas ce qu'elle garantit.
- Tu écris des messages vérifiables, assumables par le consultant s'il te relit par-dessus l'épaule.

OFFRE DU CONSULTANT : ${consultant.offre}

TON À RESPECTER :
- ${consultant.ton}
- ${consultant.tutoiement ? 'Tutoiement' : 'Vouvoiement'}
- Messages humains, courts, qui donnent envie de répondre
- JAMAIS de formules bateau ("j'espère que ce message vous trouve en forme", "suite à notre conversation", etc.)
- JAMAIS de "je reviens vers vous" en relance — apporte toujours un angle neuf

TU GÉNÈRES UNE SÉQUENCE DE 5 MESSAGES ESPACÉS EN JOURS OUVRÉS COMME SUIT :
${SCHEDULE.map(s => `- ${s.jour} (${s.offsetBusinessDays} jours ouvrés après le premier envoi) — ${s.role.toUpperCase()} : ${s.brief}`).join('\n')}

RÈGLES ABSOLUES :
- Réponds UNIQUEMENT en JSON valide, aucun texte autour
- Format exact :
{
  "steps": [
    { "objet": "...", "corps": "..." },
    { "objet": "...", "corps": "..." },
    { "objet": "...", "corps": "..." },
    { "objet": "...", "corps": "..." },
    { "objet": "...", "corps": "..." }
  ]
}
- Les 5 steps dans l'ordre correspondent à J0, J+4, J+10, J+18, J+28
- Chaque "corps" utilise \\n pour les sauts de ligne
- Ne mets PAS de signature dans le corps — elle est ajoutée automatiquement après
- Ne mets PAS de "Bonjour [Prénom]" générique — utilise vraiment le prénom du lead`;
}

function buildUserPrompt({ lead, enrichments }) {
  const base = `LEAD À PROSPECTER :
- Prénom : ${lead.prenom}
- Nom : ${lead.nom || ''}
- Entreprise : ${lead.entreprise}
- Secteur : ${lead.secteur}
- Ville : ${lead.ville || ''}
- Contexte / signaux : ${lead.contexte || 'aucun signal particulier'}`;

  const prospect = enrichments && enrichments.prospectMemories && enrichments.prospectMemories.length
    ? `\n\nHISTORIQUE MEM0 DU PROSPECT (contexte factuel — ne pas citer directement, utiliser pour calibrer le ton et éviter les angles déjà tentés) :\n${formatMemories(enrichments.prospectMemories, 'prospect')}`
    : '';

  const patterns = enrichments && enrichments.patternMemories && enrichments.patternMemories.length
    ? `\n\nPATTERNS SECTORIELS OBSERVÉS (indicatif, statistiques passées — ne pas les mentionner au prospect) :\n${formatMemories(enrichments.patternMemories, 'pattern')}`
    : '';

  return `${base}${prospect}${patterns}

Génère les 4 messages de la séquence. Sois naturel, pertinent, et accroche vraiment sur la réalité du métier et du contexte du lead.`;
}

// ─── formatMemories — anti-injection + wrapping Mem0 ────────────────────────
// Neutralise les délimiteurs structurels qui pourraient amener le LLM à
// confondre le contenu mémorisé avec une nouvelle instruction. Tronque à
// MEM0_MAX_CHARS par entry pour borner le coût token et la surface de risque.

const MEM0_MAX_CHARS = 500;

function formatMemories(memories, type) {
  if (!Array.isArray(memories) || memories.length === 0) return '';
  const parts = [];
  for (const entry of memories) {
    const raw = entry && (entry.memory || (entry.data && entry.data.memory) || entry.text);
    if (!raw) continue;
    const sanitized = truncateMemory(sanitizeMemoryContent(String(raw)), MEM0_MAX_CHARS);
    parts.push(`[MEM0_START type=${type}]\n${sanitized}\n[MEM0_END]\n`);
  }
  return parts.join('');
}

function sanitizeMemoryContent(s) {
  return s
    // Neutraliser nos propres marqueurs pour qu'une mémoire ne puisse pas
    // en injecter de faux et faire croire au modèle qu'on sort de la zone.
    .replace(/\[MEM0_START/gi, '[mem0_s')
    .replace(/\[MEM0_END/gi, '[mem0_e')
    // Patterns de templating et de balise susceptibles d'abus
    .replace(/\{\{/g, '{ {')
    .replace(/\}\}/g, '} }')
    .replace(/<\//g, '< /')
    .replace(/<script/gi, '<scr_ipt')
    // Délimiteurs de blocs utilisés ailleurs dans les prompts du projet
    .replace(/```/g, "'''")
    .replace(/"""/g, "'''");
}

function truncateMemory(s, n) {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

/** Export du schedule pour que le scheduler puisse calculer les dates d'envoi */
module.exports = {
  generateSequence,
  SCHEDULE,
  // Exportés pour les tests unitaires (pas d'usage externe direct attendu)
  buildUserPrompt,
  buildSystemPrompt,
  formatMemories,
};
