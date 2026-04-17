/**
 * POST /api/sendOnboarding
 *
 * Déclenche l'envoi du mail d'onboarding David → consultant.
 *
 * Body : { "prenom": "Jean", "nom": "Dupont", "email": "jean@cabinet.fr" }
 */

const { sendOnboardingEmail } = require('../../agents/david/onboarding');

module.exports = async function (context, req) {
  try {
    const { prenom, nom, email } = req.body || {};
    if (!prenom || !email) {
      context.res = {
        status: 400,
        body: { error: 'prenom et email requis' },
      };
      return;
    }

    const result = await sendOnboardingEmail({
      consultant: { prenom, nom: nom || '', email },
    });

    context.res = { status: 200, body: { ok: true, ...result } };
  } catch (err) {
    context.log.error('sendOnboarding error:', err);
    context.res = { status: 500, body: { error: err.message } };
  }
};
