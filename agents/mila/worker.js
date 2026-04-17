/**
 * Worker Mila. Thin wrapper autour de `shared/worker.js`.
 * Identique à martin/worker.js à la constante AGENT près.
 */

const worker = require('../../shared/worker');

const AGENT = 'mila';

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
