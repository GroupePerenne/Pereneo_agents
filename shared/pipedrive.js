/**
 * Client Pipedrive — utilisé par David (manager commercial).
 *
 * David est le seul agent qui écrit dans Pipedrive. Martin et Mila passent
 * par lui pour logger leurs envois et leurs résultats.
 *
 * Le token n'est JAMAIS lu depuis une constante : toujours depuis l'env.
 *   process.env.PIPEDRIVE_TOKEN
 *   process.env.PIPEDRIVE_COMPANY_DOMAIN  (ex: "oseys")
 *
 * Doc API : https://developers.pipedrive.com/docs/api/v1
 */

const BASE_URL = () => {
  const domain = process.env.PIPEDRIVE_COMPANY_DOMAIN;
  if (!domain) throw new Error('PIPEDRIVE_COMPANY_DOMAIN non défini');
  return `https://${domain}.pipedrive.com/api/v1`;
};

const token = () => {
  const t = process.env.PIPEDRIVE_TOKEN;
  if (!t) throw new Error('PIPEDRIVE_TOKEN non défini');
  return t;
};

/** Appel HTTP bas niveau avec gestion d'erreur uniforme */
async function call(path, { method = 'GET', body = null, query = {} } = {}) {
  const url = new URL(`${BASE_URL()}${path}`);
  url.searchParams.set('api_token', token());
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }

  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url.toString(), opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    const msg = data.error || data.error_info || `HTTP ${res.status}`;
    throw new Error(`Pipedrive ${method} ${path} → ${msg}`);
  }
  return data.data;
}

// ─── Organisations ──────────────────────────────────────────────────────────

async function searchOrganization(term) {
  const data = await call('/organizations/search', {
    query: { term, exact_match: false, limit: 10 },
  });
  return data?.items?.map((i) => i.item) || [];
}

async function getOrganization(id) {
  return call(`/organizations/${id}`);
}

async function createOrganization({ name, address, ownerId }) {
  return call('/organizations', {
    method: 'POST',
    body: { name, address, owner_id: ownerId },
  });
}

// ─── Personnes ──────────────────────────────────────────────────────────────

async function searchPerson(term) {
  const data = await call('/persons/search', {
    query: { term, exact_match: false, limit: 10 },
  });
  return data?.items?.map((i) => i.item) || [];
}

async function createPerson({ name, email, phone, orgId, ownerId }) {
  return call('/persons', {
    method: 'POST',
    body: {
      name,
      email: email ? [{ value: email, primary: true }] : [],
      phone: phone ? [{ value: phone, primary: true }] : [],
      org_id: orgId,
      owner_id: ownerId,
    },
  });
}

// ─── Deals ──────────────────────────────────────────────────────────────────

async function createDeal({ title, personId, orgId, stageId, agent }) {
  // Champ personnalisé "agent" (Martin/Mila/les deux) à créer dans Pipedrive
  // et à référencer ici via sa clé (hash) — à ajuster une fois le custom field créé
  const custom = agent ? { agent_sender: agent } : {};
  return call('/deals', {
    method: 'POST',
    body: {
      title,
      person_id: personId,
      org_id: orgId,
      stage_id: stageId,
      ...custom,
    },
  });
}

async function updateDealStage(dealId, stageId) {
  return call(`/deals/${dealId}`, {
    method: 'PUT',
    body: { stage_id: stageId },
  });
}

// ─── Activités (= logs d'envoi mail) ────────────────────────────────────────

/**
 * Log un envoi de mail (J0/J3/J7/J14) par Martin ou Mila sur un deal.
 * Crée une activité de type "email" avec subject = objet du mail
 * et note = corps résumé + identité de l'expéditeur (martin/mila).
 */
async function logEmailSent({ dealId, personId, sender, day, subject, bodyPreview }) {
  return call('/activities', {
    method: 'POST',
    body: {
      subject: `[${sender}] ${day} — ${subject}`,
      type: 'email',
      done: 1,
      deal_id: dealId,
      person_id: personId,
      note: `Envoyé par ${sender} (${sender}@oseys.fr)\nÉtape : ${day}\n\n${bodyPreview}`,
    },
  });
}

/** Log une ouverture détectée par le pixel custom */
async function logEmailOpened({ dealId, personId, sender, day }) {
  return call('/activities', {
    method: 'POST',
    body: {
      subject: `[${sender}] ${day} — mail ouvert`,
      type: 'email_open',
      done: 1,
      deal_id: dealId,
      person_id: personId,
    },
  });
}

// ─── Export ─────────────────────────────────────────────────────────────────

module.exports = {
  searchOrganization,
  getOrganization,
  createOrganization,
  searchPerson,
  createPerson,
  createDeal,
  updateDealStage,
  logEmailSent,
  logEmailOpened,
};
