/**
 * Worker Martin. Thin wrapper autour de `shared/worker.js`.
 * Expose deux fonctions :
 *   - bootstrapSequence(ctx) — appelée par la function runSequence pour J0
 *   - sendStep(job) — appelée par le scheduler pour J3/J7/J14
 */

const worker = require('../../shared/worker');

const AGENT = 'martin';

async function bootstrapSequence({ consultant, lead, dealId, personId }) {
  return worker.bootstrapSequence({
    agent: AGENT,
    consultant,
    lead,
    dealId,
    personId,
  });
}

async function sendStep(job) {
  if (job.agent !== AGENT) {
    throw new Error(`Job pour ${job.agent} adressé à ${AGENT}`);
  }
  return worker.sendScheduledStep(job);
}

module.exports = { bootstrapSequence, sendStep, AGENT };
