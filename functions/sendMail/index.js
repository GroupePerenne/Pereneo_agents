/**
 * POST /api/sendMail
 *
 * Body :
 * {
 *   "from": "david@oseys.fr" | "martin@oseys.fr" | "mila@oseys.fr",
 *   "to":   "constantin@example.fr" | ["a@x", "b@y"],
 *   "cc":   ["c@z"]  (optionnel),
 *   "subject": "...",
 *   "html": "...",
 *   "replyTo": "..."  (optionnel)
 * }
 *
 * Les `from` autorisés sont validés contre les variables d'env
 * DAVID_EMAIL / MARTIN_EMAIL / MILA_EMAIL pour éviter les abus.
 */

const { sendMail } = require('../../shared/graph-mail');

module.exports = async function (context, req) {
  try {
    const body = req.body || {};
    const { from, to, subject, html } = body;

    if (!from || !to || !subject || !html) {
      context.res = {
        status: 400,
        body: { error: 'Champs requis : from, to, subject, html' },
      };
      return;
    }

    const allowed = [
      process.env.DAVID_EMAIL,
      process.env.MARTIN_EMAIL,
      process.env.MILA_EMAIL,
    ].filter(Boolean);

    if (!allowed.includes(from)) {
      context.res = {
        status: 403,
        body: { error: `Adresse d'envoi non autorisée : ${from}` },
      };
      return;
    }

    const result = await sendMail({
      from,
      to,
      cc: body.cc,
      subject,
      html,
      replyTo: body.replyTo,
    });

    context.res = { status: 200, body: { success: true, ...result } };
  } catch (err) {
    context.log.error('sendMail error:', err);
    context.res = { status: 500, body: { error: err.message } };
  }
};
