/**
 * POST /api/onQualification
 *
 * Endpoint appelé directement par le formulaire HTML quand le consultant clique
 * "Envoyer à David". On :
 *   1. Notifie David par mail avec un récap structuré
 *   2. Envoie un accusé au consultant
 *   3. Retourne 200 + { ok: true, brief_id } au formulaire
 *
 * Auth anonyme côté Azure (le formulaire est public), mais on pourrait
 * ajouter un hCaptcha ou un throttle IP en V2 si du spam apparaît.
 */

const { app } = require('@azure/functions');
const { sendMail } = require('../../shared/graph-mail');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

app.http('onQualification', {
  methods: ['POST', 'OPTIONS'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    if (request.method === 'OPTIONS') {
      return { status: 204, headers: CORS_HEADERS };
    }

    try {
      const brief = await request.json().catch(() => ({}));
      const required = ['nom', 'email', 'offre'];
      const missing = required.filter((f) => !brief[f]);
      if (missing.length) {
        return {
          status: 400,
          headers: CORS_HEADERS,
          jsonBody: { error: `Champs manquants : ${missing.join(', ')}` },
        };
      }

      const briefId = `brief_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      await sendMail({
        from: process.env.DAVID_EMAIL,
        to: process.env.DAVID_EMAIL,
        subject: `[Qualification] ${brief.nom} — ${brief.entreprise || 'cabinet non précisé'}`,
        html: renderBriefEmail(brief, briefId),
      });

      await sendMail({
        from: process.env.DAVID_EMAIL,
        to: brief.email,
        subject: 'Brief bien reçu — je reviens vers toi sous 24h',
        html: `<p>Salut ${brief.nom.split(/\s+/)[0]},</p>
<p>J'ai bien reçu ton brief. Je relis tout ça et je te reviens sous 24h avec un premier retour et un batch de leads à te proposer.</p>
<p>Si tu veux ajuster quelque chose avant, réponds simplement à ce mail.</p>
<p>David</p>`,
      });

      return {
        status: 200,
        headers: CORS_HEADERS,
        jsonBody: { ok: true, brief_id: briefId },
      };
    } catch (err) {
      context.error('onQualification error:', err);
      return {
        status: 500,
        headers: CORS_HEADERS,
        jsonBody: { error: err.message },
      };
    }
  },
});

function renderBriefEmail(brief, briefId) {
  const row = (k, v) => v
    ? `<tr><td style="padding:6px 12px 6px 0;font-size:12px;color:#7a756f;vertical-align:top">${k}</td><td style="padding:6px 0;font-size:13px;color:#1a1714">${escapeHtml(v)}</td></tr>`
    : '';
  return `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="font-family:Arial,sans-serif">
<tr><td>
<h2 style="font-size:18px;color:#1a1714;margin:0 0 12px">Nouveau brief consultant</h2>
<p style="color:#7a756f;font-size:12px;margin:0 0 16px">ID : ${briefId} · ${new Date().toISOString()}</p>
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-top:1px solid #E2DDD8;padding-top:12px">
  ${row('Nom', brief.nom)}
  ${row('Email', brief.email)}
  ${row('Cabinet', brief.entreprise)}
  ${row('Téléphone', brief.telephone)}
  ${row('Ville', brief.ville)}
  ${row('LinkedIn', brief.linkedin)}
  ${row('Prospecteur choisi', brief.prospecteur)}
  ${row('Offre', brief.offre)}
  ${row('Secteurs cibles', brief.secteurs)}
  ${row('Tranche effectif', brief.effectif)}
  ${row('Zone géo', brief.zone)}
  ${row('Registre', brief.registre)}
  ${row('Tu / vous', brief.vouvoiement)}
  ${row('Exemple client', brief.exemple_client)}
</table>
</td></tr>
</table>`;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}
