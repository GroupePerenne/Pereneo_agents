/**
 * POST /api/runLeadSelectorForConsultant
 *
 * Re-déclenche le Lead Selector pour un consultant déjà connu (brief stocké
 * dans Mem0). Usage : Paul via curl/Postman, Charli plus tard, cockpit futur.
 *
 * Body attendu :
 * {
 *   "consultantId": "morgane.dupont@oseys.fr",   // email lowercased, requis
 *   "batchSize":    10,                          // optionnel, défaut LEAD_SELECTOR_BATCH_SIZE
 *   "dryRun":       true                         // optionnel : retourne le batch SANS lancer la séquence
 * }
 */

const { app } = require('@azure/functions');
const {
  selectLeadsForConsultantById,
  reviveBriefFromConsultantMemory,
  parseBriefFromMemories,
} = require('../../shared/leadSelector');
const { launchSequenceForConsultant } = require('../../agents/david/orchestrator');
const { getMem0 } = require('../../shared/adapters/memory/mem0');

app.http('runLeadSelectorForConsultant', {
  methods: ['POST'],
  authLevel: 'function',
  handler: async (request, context) => {
    try {
      const body = await request.json().catch(() => ({}));
      const { consultantId, batchSize, dryRun } = body;
      if (!consultantId) {
        return {
          status: 400,
          jsonBody: { error: 'consultantId requis (email lowercased)' },
        };
      }

      const result = await selectLeadsForConsultantById({
        consultantId,
        batchSize,
        context,
      });

      if (dryRun || result.status === 'empty' || result.status === 'error') {
        return { status: 200, jsonBody: { leadSelector: result } };
      }

      // ok / insufficient → on lance la séquence
      const consultant = await rebuildConsultantFromMem0(consultantId, context);
      if (!consultant) {
        return {
          status: 200,
          jsonBody: {
            leadSelector: result,
            sequence: { error: 'consultant_payload_unavailable_in_mem0' },
          },
        };
      }

      const seqResults = await launchSequenceForConsultant({
        consultant: consultant.consultant,
        brief: consultant.brief,
        leads: result.leads,
        context,
      });

      return {
        status: 200,
        jsonBody: {
          leadSelector: result,
          sequence: {
            ok_count: seqResults.filter((r) => !r.error).length,
            error_count: seqResults.filter((r) => r.error).length,
            results: seqResults,
          },
        },
      };
    } catch (err) {
      if (context && typeof context.error === 'function') {
        context.error('runLeadSelectorForConsultant error', err);
      }
      return { status: 500, jsonBody: { error: err.message } };
    }
  },
});

/**
 * Reconstitue { consultant, brief } attendu par launchSequenceForConsultant
 * depuis les memories Mem0 du consultant.
 */
async function rebuildConsultantFromMem0(consultantId, context) {
  const mem0 = getMem0(context);
  if (!mem0) return null;
  let memories;
  try {
    memories = await mem0.retrieveConsultant(consultantId);
  } catch {
    return null;
  }
  if (!memories || memories.length === 0) return null;
  const brief = parseBriefFromMemories(memories);
  if (!brief) return null;
  return {
    consultant: {
      nom: brief.nom,
      email: brief.email,
      offre: brief.offre,
      ton: brief.registre,
      tutoiement: brief.vouvoiement === 'tu',
    },
    brief: { prospecteur: brief.prospecteur || 'both' },
  };
}
