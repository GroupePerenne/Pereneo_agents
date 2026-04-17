/**
 * POST /api/runSequence
 *
 * Déclenche une séquence de prospection pour un batch de leads au nom d'un
 * consultant. Utilisé par David après validation du brief.
 *
 * Body attendu :
 * {
 *   "consultant": { "nom": "...", "email": "...", "offre": "...", "ton": "...", "tutoiement": true },
 *   "brief":      { "prospecteur": "martin" | "mila" | "both" },
 *   "leads":      [ { "prenom": "...", "entreprise": "...", "email": "...", "secteur": "...", ... } ]
 * }
 */

const { launchSequenceForConsultant } = require('../../agents/david/orchestrator');

module.exports = async function (context, req) {
  try {
    const { consultant, brief, leads } = req.body || {};
    if (!consultant || !brief || !Array.isArray(leads) || leads.length === 0) {
      context.res = {
        status: 400,
        body: { error: 'consultant, brief et leads[] requis' },
      };
      return;
    }

    const results = await launchSequenceForConsultant({ consultant, brief, leads });
    const ok = results.filter((r) => !r.error).length;
    const ko = results.length - ok;

    context.res = {
      status: 200,
      body: { ok_count: ok, error_count: ko, results },
    };
  } catch (err) {
    context.log.error('runSequence error:', err);
    context.res = { status: 500, body: { error: err.message } };
  }
};
