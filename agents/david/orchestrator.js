/**
 * Orchestrator David.
 *
 * Deux points d'entrée :
 *   1. `handleInboxPoll()` — appelé périodiquement par le timer trigger
 *      `davidInbox` pour lire les mails non lus et les router.
 *   2. `launchSequenceForConsultant(brief, leads)` — appelé par David après
 *      validation d'un brief consultant, pour déclencher Martin et/ou Mila.
 *
 * David est le seul agent qui parle aux consultants. Martin et Mila ont
 * leur `replyTo` configuré sur david@oseys.fr : toute réponse d'un prospect
 * atterrit donc dans la boîte de David, qui décide quoi en faire.
 */

const fs = require('fs');
const path = require('path');
const { listUnreadMessages, markAsRead, sendMail } = require('../../shared/graph-mail');
const { callClaude, parseJson } = require('../../shared/anthropic');
const martin = require('../martin/worker');
const mila = require('../mila/worker');
const pipedrive = require('../../shared/pipedrive');

const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf8');

// ─── Lecture et routage de l'inbox ─────────────────────────────────────────
async function handleInboxPoll() {
  const mailbox = process.env.DAVID_EMAIL;
  const unread = await listUnreadMessages({ mailbox, top: 20 });

  const results = [];
  for (const msg of unread) {
    try {
      const decision = await routeMessage(msg);
      results.push({ id: msg.id, subject: msg.subject, ...decision });
      await markAsRead({ mailbox, messageId: msg.id });
    } catch (err) {
      results.push({ id: msg.id, error: err.message });
    }
  }
  return results;
}

/**
 * Demande à Claude comment router un message reçu dans la boîte de David.
 * Les 3 grands cas :
 *  - Réponse d'un prospect → forward au consultant concerné + update Pipedrive
 *  - Message d'un consultant → répondre / ajuster le brief / déclencher action
 *  - Spam / hors sujet → archiver
 */
async function routeMessage(msg) {
  const fromAddress = msg.from?.emailAddress?.address || 'inconnu';
  const bodyText = (msg.body?.content || msg.bodyPreview || '').replace(/<[^>]+>/g, '').slice(0, 3000);

  const prompt = `Message reçu dans la boîte david@oseys.fr :

DE : ${fromAddress}
OBJET : ${msg.subject}
CORPS :
"""
${bodyText}
"""

Classe ce message et propose une action. Réponds UNIQUEMENT en JSON strict :
{
  "classe": "prospect_reply" | "consultant_message" | "internal" | "spam",
  "resume_humain": "1 phrase courte pour Paul",
  "action_immediate": "description de ce que David doit faire",
  "reply_draft": "corps du mail à envoyer, ou null si rien à envoyer",
  "reply_to": "adresse destinataire, ou null",
  "reply_subject": "objet du mail, ou null"
}`;

  const { text } = await callClaude({
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 1200,
    temperature: 0.4,
  });

  let decision;
  try {
    decision = parseJson(text);
  } catch (e) {
    return { classe: 'unparseable', raw: text.slice(0, 200) };
  }

  // Exécution de l'action si un draft est fourni
  if (decision.reply_draft && decision.reply_to && decision.reply_subject) {
    await sendMail({
      from: process.env.DAVID_EMAIL,
      to: decision.reply_to,
      subject: decision.reply_subject,
      html: wrapHtml(decision.reply_draft),
    });
  }

  return decision;
}

function wrapHtml(text) {
  const paragraphs = text
    .split('\n\n')
    .map((p) => `<p style="margin:0 0 14px;line-height:1.6;color:#1a1714">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
  return `<div style="font-family:Arial,sans-serif;color:#1a1714">${paragraphs}</div>`;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

// ─── Lancement d'une séquence pour un consultant ──────────────────────────
/**
 * David décide, pour chaque lead d'un batch, quel agent le prospecte.
 * Si le consultant a choisi "both", on alterne Martin/Mila pour faire de
 * l'A/B test par secteur.
 *
 * @param {Object} brief
 * @param {string} brief.prospecteur — "martin" | "mila" | "both"
 * @param {Object} consultant — { nom, email, offre, ton, tutoiement }
 * @param {Array} leads — [{ prenom, nom, entreprise, email, secteur, ville, contexte }, ...]
 */
async function launchSequenceForConsultant({ consultant, brief, leads }) {
  const assign = (i) => {
    if (brief.prospecteur === 'martin') return 'martin';
    if (brief.prospecteur === 'mila') return 'mila';
    return i % 2 === 0 ? 'martin' : 'mila';
  };

  const results = [];
  for (let i = 0; i < leads.length; i++) {
    const lead = leads[i];
    const agentKey = assign(i);
    const agent = agentKey === 'martin' ? martin : mila;

    try {
      // Crée org + person + deal dans Pipedrive avant d'envoyer
      const org = await ensureOrg(lead);
      const person = await ensurePerson(lead, org.id);
      const deal = await pipedrive.createDeal({
        title: `${consultant.nom} → ${lead.entreprise}`,
        personId: person.id,
        orgId: org.id,
        stageId: parseInt(process.env.PIPEDRIVE_STAGE_NEW || '1', 10),
        agent: agentKey,
      });

      const result = await agent.bootstrapSequence({
        consultant,
        lead,
        dealId: deal.id,
        personId: person.id,
      });
      results.push({ lead: lead.email, agent: agentKey, dealId: deal.id, ...result });
    } catch (err) {
      results.push({ lead: lead.email, agent: agentKey, error: err.message });
    }
  }
  return results;
}

async function ensureOrg(lead) {
  const found = await pipedrive.searchOrganization(lead.entreprise);
  if (found.length) return found[0];
  return pipedrive.createOrganization({
    name: lead.entreprise,
    address: lead.ville,
  });
}

async function ensurePerson(lead, orgId) {
  if (lead.email) {
    const found = await pipedrive.searchPerson(lead.email);
    if (found.length) return found[0];
  }
  return pipedrive.createPerson({
    name: `${lead.prenom} ${lead.nom || ''}`.trim(),
    email: lead.email,
    orgId,
  });
}

module.exports = {
  handleInboxPoll,
  launchSequenceForConsultant,
};
