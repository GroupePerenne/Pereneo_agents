# Architecture — Orchestration des 3 agents

## Vue d'ensemble

```
┌──────────────┐        ┌────────────────────┐         ┌──────────────┐
│  Consultant  │◀──────▶│  David (manager)   │◀───────▶│   Pipedrive  │
│  OSEYS       │  mail  │  david@oseys.fr    │   API   │   (CRM)      │
└──────────────┘        └────────────────────┘         └──────────────┘
                                  │
                       brief, config, trigger
                                  │
                 ┌────────────────┴────────────────┐
                 ▼                                 ▼
      ┌──────────────────┐              ┌──────────────────┐
      │  Martin (worker) │              │   Mila (worker)  │
      │ martin@oseys.fr  │              │   mila@oseys.fr  │
      └─────────┬────────┘              └─────────┬────────┘
                │                                 │
                └────────────┬────────────────────┘
                             ▼
                    ┌─────────────────┐
                    │   Prospects     │
                    │  (envoi J0..J14)│
                    └─────────────────┘
```

---

## Séparation des responsabilités

### David — Couche conversationnelle

David est un **agent LLM** (Claude API). Il n'envoie jamais à un prospect. Il parle uniquement aux consultants OSEYS.

**Ses capacités :**
- Lire sa boîte `david@oseys.fr` (Microsoft Graph `Mail.Read`)
- Répondre aux consultants (Microsoft Graph `Mail.Send`)
- Lire et écrire dans Pipedrive (API token David)
- Déclencher une séquence pour Martin et/ou Mila (trigger Azure Function)
- Consulter la performance historique de Martin vs Mila par secteur

**Ses moments d'activation :**
1. Un consultant arrive dans le réseau → David envoie l'onboarding (niveaux 1/2/3 + choix Martin/Mila/les deux)
2. Un consultant répond / demande quelque chose → David traite la demande
3. Un consultant soumet son formulaire de qualification → David brief Martin/Mila et lance la séquence
4. Un prospect répond positivement → David prévient le consultant + pose un RDV via Pipedrive

### Martin & Mila — Couche d'exécution

Agents **quasi-déterministes** (pas de vraie conversation). Ils reçoivent un brief structuré de David, exécutent une séquence, loggent les résultats.

**Leurs capacités :**
- Envoyer depuis leur propre boîte (`martin@oseys.fr` / `mila@oseys.fr`)
- Générer le contenu des 4 étapes (J0/J3/J7/J14) via Claude API, personnalisé au lead et au consultant
- Respecter leur identité (signature, prénom, photo) chargée depuis `agents/{martin|mila}/identity.json`
- Logger chaque envoi dans Pipedrive (via David, pas en direct — Pipedrive n'a qu'un compte)
- S'arrêter si le prospect répond (Martin/Mila ne répondent jamais — c'est David qui prend le relais et transmet au consultant)

**Ce qu'ils ne font pas :**
- Ne parlent jamais aux consultants
- N'ont pas d'accès direct à Pipedrive (David logge pour eux via son token)
- Ne prennent aucune décision stratégique (choix de cible, calage du ton général)

---

## Flow complet d'un cycle consultant

```
1. Inscription consultant
      ▼
2. David envoie mail d'onboarding (niveau 1/2/3 + choix Martin/Mila/les deux)
      ▼
3. Consultant clique son choix → Azure Function `choixNiveau` log la réponse
      ▼
4. David envoie le formulaire de qualification (avec URL préremplie : nom, email)
      ▼
5. Consultant remplit et submit → Azure Function `onQualification` parse
      ▼
6. David brief Martin et/ou Mila via trigger :
   - Profil cible
   - Liste de leads (issue de la base GPT/Pharow)
   - Ton et identité consultant
   - Choix du ou des prospecteurs
      ▼
7. Martin/Mila génèrent et envoient J0 → attente 3j → J3 → 4j → J7 → 7j → J14
   (chaque envoi loggé dans Pipedrive par David)
      ▼
8. Si réponse prospect → l'agent concerné s'arrête, David notifie consultant + ouvre deal dans Pipedrive
      ▼
9. Si pas de réponse après J14 → stage "Pas de réponse" dans Pipedrive, rupture polie
```

---

## Séquence J0 / J3 / J7 / J14

| Jour | Canal           | Objectif                                      | Longueur |
|------|-----------------|-----------------------------------------------|----------|
| J0   | Email           | Ouverture — question courte, pas de pitch    | 4-6 lignes |
| J3   | Email (relance) | Rappel contextuel — apporter un angle nouveau | 3-5 lignes |
| J7   | Email (valeur)  | Proposer une observation / un insight         | 5-8 lignes |
| J14  | Email (rupture) | Sortie polie — ouvre la porte du retour       | 3-4 lignes |

**Pourquoi ce rythme plutôt que 6 étapes sur 28 jours :**
- Plus dense = moins de chance que le lead oublie entre deux touches
- Cycle court = on libère vite le slot pour un nouveau lead si pas de trac
- 4 touches suffisent statistiquement à faire émerger l'intérêt (études SalesHandy, Yesware)

---

## Tracking d'ouverture

Pipedrive offre le tracking natif d'ouverture et de clic quand les mails sont envoyés depuis une boîte connectée. **David** est connecté à Pipedrive — donc tous les logs de mails qu'il remonte dans Pipedrive bénéficient du tracking.

Pour Martin et Mila : les envois se font via Graph API, donc pas de tracking natif Pipedrive. Deux solutions :
1. **Pixel de tracking custom** injecté dans le HTML du mail (image 1×1 hébergée sur un endpoint Azure Function qui log l'ouverture)
2. **Connecter Martin et Mila à Pipedrive comme "utilisateurs partagés"** — à explorer selon le plan Pipedrive

Approche recommandée pour la V1 : pixel custom. Simple, contrôlé, agnostique du plan Pipedrive.

---

## Sécurité

- Tous les secrets (Pipedrive token, Anthropic API key, Azure client secret) vivent en **variables d'environnement Azure Function App**, jamais dans le code
- `.env.local` est gitignored pour le dev local
- Les briefs consultants (`briefs/*.json`) sont gitignored — contiennent des données privées (stratégie, cibles, prix)
- Le mail frais entrant est filtré en entrée de David : un expéditeur inconnu qui demande de la data ou déclenche une action inattendue est mis en quarantaine et pas traité
