/**
 * Azure Queue Storage — file d'attente des relances J3/J7/J14.
 *
 * Principe : quand Martin/Mila envoient J0, ils poussent 3 messages dans la
 * file avec des `visibilityTimeout` de 3d, 7d, 14d (en secondes).
 * Le scheduler (Azure Function timer trigger) consomme la file toutes les
 * X minutes et fire les envois dont l'échéance est passée.
 *
 * Avantage sur une solution "base de données + cron" : Azure gère la
 * visibilité et la durabilité. On ne rate jamais un envoi, on ne double
 * jamais un envoi.
 */

const { QueueServiceClient } = require('@azure/storage-queue');

const QUEUE_NAME = () => process.env.QUEUE_NAME_RELANCES || 'mila-relances';

let _client = null;
function client() {
  if (_client) return _client;
  const conn = process.env.AzureWebJobsStorage;
  if (!conn) throw new Error('AzureWebJobsStorage non défini');
  _client = QueueServiceClient.fromConnectionString(conn).getQueueClient(QUEUE_NAME());
  return _client;
}

/** S'assure que la queue existe (idempotent) */
async function ensureQueue() {
  await client().createIfNotExists();
}

/**
 * Programme une relance.
 * @param {Object} job
 * @param {string} job.agent       — "martin" ou "mila"
 * @param {string} job.day         — "J3" | "J7" | "J14"
 * @param {number} job.offsetDays  — délai depuis maintenant (3, 7, 14)
 * @param {Object} job.lead        — profil lead (prenom, email, entreprise, secteur, ville, contexte)
 * @param {Object} job.consultant  — { id, nom, email, offre, ton, tutoiement }
 * @param {number} [job.dealId]    — id Pipedrive
 * @param {number} [job.personId]  — id Pipedrive
 */
async function scheduleRelance(job) {
  await ensureQueue();
  const payload = Buffer.from(JSON.stringify(job)).toString('base64');
  const visibilitySeconds = Math.floor(job.offsetDays * 86_400);
  const ttlSeconds = Math.max(visibilitySeconds + 86_400 * 7, 86_400 * 30); // ne pas expirer avant l'échéance + buffer
  return client().sendMessage(payload, {
    visibilityTimeout: visibilitySeconds,
    messageTimeToLive: ttlSeconds,
  });
}

/** Récupère les messages dus (consommation par le scheduler) */
async function receiveDueRelances(maxMessages = 16) {
  await ensureQueue();
  const { receivedMessageItems } = await client().receiveMessages({
    numberOfMessages: Math.min(maxMessages, 32),
    visibilityTimeout: 120, // on a 2 min pour traiter avant qu'un autre worker ne reprenne
  });
  return receivedMessageItems.map((m) => ({
    messageId: m.messageId,
    popReceipt: m.popReceipt,
    body: JSON.parse(Buffer.from(m.messageText, 'base64').toString('utf8')),
  }));
}

/** Supprime un message une fois traité avec succès */
async function deleteRelance({ messageId, popReceipt }) {
  return client().deleteMessage(messageId, popReceipt);
}

module.exports = {
  scheduleRelance,
  receiveDueRelances,
  deleteRelance,
  ensureQueue,
};
