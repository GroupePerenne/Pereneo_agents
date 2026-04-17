/**
 * GET /api/choixNiveau?niveau=1|2|3&prospecteur=martin|mila|both&consultant=Nom&email=...
 *
 * Appelé quand un consultant clique sur un bouton dans le mail d'onboarding
 * envoyé par David. On :
 *   1. Envoie un accusé au consultant (depuis david@oseys.fr)
 *   2. Envoie une alerte à l'admin (paul.rudler@oseys.fr)
 *   3. Retourne une page HTML de confirmation dans le navigateur
 */

const { sendMail } = require('../../shared/graph-mail');
const { confirmationPage } = require('../../shared/templates');

module.exports = async function (context, req) {
  const niveau = parseInt(req.query.niveau || '', 10);
  const prospecteur = (req.query.prospecteur || '').toLowerCase();
  const consultantName = req.query.consultant || 'consultant';
  const consultantEmail = req.query.email || '';
  const consultantPrenom = consultantName.split(/\s+/)[0] || 'Salut';

  // Valeurs autorisées
  const validNiveau = [1, 2, 3].includes(niveau) ? niveau : null;
  const validProspecteur = ['martin', 'mila', 'both'].includes(prospecteur) ? prospecteur : null;

  if (!validNiveau && !validProspecteur) {
    context.res = {
      status: 400,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: '<p>Paramètre niveau ou prospecteur manquant.</p>',
    };
    return;
  }

  // Page de confirmation (immédiate pour l'UX)
  const html = confirmationPage({
    consultantPrenom,
    niveau: validNiveau,
    prospecteur: validProspecteur,
  });

  context.res = {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: html,
  };

  // Mails asynchrones — on n'attend pas si ça plante, on log juste
  const niveauLabel = { 1: 'Niveau 1 (pour toi)', 2: 'Niveau 2 (validation)', 3: 'Niveau 3 (chez toi)' }[validNiveau] || '—';
  const prospecteurLabel = { martin: 'Martin', mila: 'Mila', both: 'Martin & Mila' }[validProspecteur] || '—';

  try {
    // 1. Accusé de réception au consultant
    if (consultantEmail) {
      await sendMail({
        from: process.env.DAVID_EMAIL,
        to: consultantEmail,
        subject: 'C\'est noté — je reviens vers toi très vite',
        html: `<p>Salut ${consultantPrenom},</p>
<p>J'ai bien reçu ton choix :</p>
<ul>
  <li><strong>Niveau :</strong> ${niveauLabel}</li>
  <li><strong>Prospecteur :</strong> ${prospecteurLabel}</li>
</ul>
<p>Je te recontacte rapidement avec un lien vers le formulaire de qualification pour qu'on cale ta cible précise.</p>
<p>À très vite,<br>David</p>`,
      });
    }
  } catch (e) {
    context.log.error('Accusé consultant échoué:', e.message);
  }

  try {
    // 2. Alerte à l'admin
    const admin = process.env.ADMIN_EMAIL;
    if (admin) {
      await sendMail({
        from: process.env.DAVID_EMAIL,
        to: admin,
        subject: `[OSEYS] Choix niveau/prospecteur — ${consultantName}`,
        html: `<p>Nouveau choix reçu :</p>
<ul>
  <li>Consultant : ${consultantName} (${consultantEmail || 'email non fourni'})</li>
  <li>Niveau : ${niveauLabel}</li>
  <li>Prospecteur : ${prospecteurLabel}</li>
  <li>Horodatage : ${new Date().toISOString()}</li>
</ul>`,
      });
    }
  } catch (e) {
    context.log.error('Alerte admin échouée:', e.message);
  }
};
