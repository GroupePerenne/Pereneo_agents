/**
 * GET /api/trackOpen?deal=<id>&person=<id>&agent=<martin|mila>&day=<J0|J3|J7|J14>
 *
 * Injecté en fin de mail par Martin/Mila :
 *   <img src="https://.../api/trackOpen?deal=42&agent=martin&day=J0" width="1" height="1">
 *
 * Quand le client mail du prospect charge l'image, on logge l'ouverture
 * dans Pipedrive comme activité "email_open". On retourne toujours le pixel
 * GIF transparent, même en cas d'erreur, pour ne pas afficher d'icône cassée.
 */

const pipedrive = require('../../shared/pipedrive');
const { PIXEL_GIF } = require('../../shared/templates');

module.exports = async function (context, req) {
  // On répond d'abord avec le pixel, toujours, pour ne pas bloquer le mail
  context.res = {
    status: 200,
    headers: {
      'Content-Type': 'image/gif',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
    },
    body: PIXEL_GIF,
    isRaw: true,
  };

  // Puis on logge, best-effort
  try {
    const dealId = parseInt(req.query.deal || '', 10);
    const personId = parseInt(req.query.person || '', 10);
    const agent = (req.query.agent || '').toLowerCase();
    const day = req.query.day || 'J?';

    if (!dealId && !personId) return; // rien à logguer
    if (!['martin', 'mila'].includes(agent)) return;

    await pipedrive.logEmailOpened({
      dealId: dealId || undefined,
      personId: personId || undefined,
      sender: agent,
      day,
    });
  } catch (err) {
    context.log.warn('trackOpen log failed:', err.message);
  }
};
