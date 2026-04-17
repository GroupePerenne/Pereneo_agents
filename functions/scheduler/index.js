/**
 * Timer trigger — toutes les 15 minutes.
 *
 * Consomme la queue Azure des relances J3/J7/J14. Pour chaque message dû :
 *   - récupère le job
 *   - délègue au worker de l'agent (Martin ou Mila)
 *   - supprime le message de la queue si l'envoi a réussi
 *   - sinon, laisse le message retourner en visible (retry automatique)
 *
 * La queue garantit at-least-once. Chaque job contient les contenus déjà
 * générés au J0, donc aucun appel LLM n'est refait à l'échéance —
 * cohérence du discours garantie sur la séquence complète.
 */

const { app } = require('@azure/functions');
const { receiveDueRelances, deleteRelance } = require('../../shared/queue');
const martin = require('../../agents/martin/worker');
const mila = require('../../agents/mila/worker');

const AGENTS = { martin, mila };

app.timer('scheduler', {
  schedule: '0 */15 * * * *',
  handler: async (myTimer, context) => {
    const startedAt = new Date().toISOString();
    context.log(`scheduler tick @ ${startedAt}`);

    try {
      const dueJobs = await receiveDueRelances(16);
      if (dueJobs.length === 0) {
        context.log('rien à envoyer');
        return;
      }

      context.log(`${dueJobs.length} relance(s) à traiter`);
      const results = [];

      for (const job of dueJobs) {
        const { body, messageId, popReceipt } = job;
        try {
          const agent = AGENTS[body.agent];
          if (!agent) throw new Error(`Agent inconnu : ${body.agent}`);

          const res = await agent.sendStep(body);
          await deleteRelance({ messageId, popReceipt });
          results.push({ agent: body.agent, day: body.day, lead: body.lead?.email, ...res });
        } catch (err) {
          context.error(`échec ${body.agent}/${body.day}/${body.lead?.email}: ${err.message}`);
          results.push({ agent: body.agent, day: body.day, lead: body.lead?.email, error: err.message });
        }
      }

      context.log('résultats:', JSON.stringify(results));
    } catch (err) {
      context.error('scheduler global error:', err);
    }
  },
});
