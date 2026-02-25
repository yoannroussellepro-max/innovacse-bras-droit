import express from "express";
import OpenAI from "openai";
import { Client as NotionClient } from "@notionhq/client";

const app = express();
app.use(express.json({ limit: "1mb" }));

// =====================
// ENV
// =====================
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const NOTION_TOKEN = process.env.NOTION_TOKEN;

const DB_JOURNAL = process.env.NOTION_DB_JOURNAL_AGENT_DIRECTEUR;
const DB_DOCTRINE = process.env.NOTION_DB_DOCTRINE_VIVANTE;
const DB_PROJETS = process.env.NOTION_DB_PROJETS;
const DB_DECISIONS = process.env.NOTION_DB_DECISIONS_STRATEGIQUES;

if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
if (!NOTION_TOKEN) throw new Error("Missing NOTION_TOKEN");
if (!DB_JOURNAL) throw new Error("Missing NOTION_DB_JOURNAL_AGENT_DIRECTEUR");
if (!DB_DOCTRINE) throw new Error("Missing NOTION_DB_DOCTRINE_VIVANTE");
if (!DB_PROJETS) throw new Error("Missing NOTION_DB_PROJETS");
if (!DB_DECISIONS) throw new Error("Missing NOTION_DB_DECISIONS_STRATEGIQUES");

// =====================
// CLIENTS
// =====================
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const notion = new NotionClient({ auth: NOTION_TOKEN });

// =====================
// MODE B — absorption livrable agent
// =====================
function extractAgentLivrable(orchestration_results) {
  for (const r of orchestration_results || []) {
    if (!r?.ok) continue;
    const livrable = r?.data?.livrable;
    if (typeof livrable === "string" && livrable.trim().length > 0) return livrable.trim();
  }
  return "";
}

// =====================
// NOTION HELPERS
// =====================
const cache = {
  dbMeta: new Map(), // database_id -> { titleProp, props, selectOptions: Map(propName->Set(options)) }
};

async function getDbMeta(database_id) {
  if (cache.dbMeta.has(database_id)) return cache.dbMeta.get(database_id);

  const db = await notion.databases.retrieve({ database_id });
  const props = db.properties || {};

  // Find Title property name
  let titlePropName = null;
  for (const [name, def] of Object.entries(props)) {
    if (def.type === "title") {
      titlePropName = name;
      break;
    }
  }
  if (!titlePropName) throw new Error(`No title property found for DB ${database_id}`);

  // Build select options sets
  const selectOptions = new Map();
  for (const [name, def] of Object.entries(props)) {
    if (def.type === "select") {
      selectOptions.set(name, new Set((def.select?.options || []).map((o) => o.name)));
    }
    if (def.type === "multi_select") {
      selectOptions.set(name, new Set((def.multi_select?.options || []).map((o) => o.name)));
    }
  }

  const meta = { titleProp: titlePropName, props, selectOptions };
  cache.dbMeta.set(database_id, meta);
  return meta;
}

function rich(text, max = 1900) {
  return { rich_text: [{ text: { content: String(text ?? "").slice(0, max) } }] };
}

function titleProp(text, max = 120) {
  return { title: [{ text: { content: String(text ?? "").slice(0, max) } }] };
}

function dateProp(iso) {
  return { date: { start: iso } };
}

function safeSelect(meta, propName, value) {
  if (!value) return null;
  const set = meta.selectOptions.get(propName);
  if (!set) return null;
  if (!set.has(value)) return null;
  return { select: { name: value } };
}

function safeMultiSelect(meta, propName, values) {
  if (!values || !Array.isArray(values) || values.length === 0) return null;
  const set = meta.selectOptions.get(propName);
  if (!set) return null;

  const filtered = values
    .filter((v) => typeof v === "string" && set.has(v))
    .map((v) => ({ name: v }));

  if (filtered.length === 0) return null;
  return { multi_select: filtered };
}
async function findPageIdByExactTitle(database_id, titlePropName, titleText) {
  const res = await notion.databases.query({
    database_id,
    page_size: 1,
    filter: {
      property: titlePropName,
      title: { equals: String(titleText || "") },
    },
  });

  const page = (res.results || [])[0];
  return page?.id || null;
}

async function fetchLatest(database_id, page_size = 10) {
  const res = await notion.databases.query({
    database_id,
    page_size,
    sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
  });
  return res.results || [];
}

function extractTitleValue(page) {
  const props = page.properties || {};
  for (const key in props) {
    const p = props[key];
    if (p?.type === "title") return (p.title || []).map((t) => t.plain_text).join("");
  }
  return "";
}

function extractRichValue(page, propName) {
  const p = page.properties?.[propName];
  if (!p) return "";

  if (p.type === "rich_text") return (p.rich_text || []).map((t) => t.plain_text).join("");
  if (p.type === "title") return (p.title || []).map((t) => t.plain_text).join("");
  if (p.type === "select") return p.select?.name || "";
  if (p.type === "multi_select") return (p.multi_select || []).map((o) => o.name).join(", ");
  if (p.type === "date") return p.date?.start || "";
  if (p.type === "checkbox") return String(!!p.checkbox);

  return "";
}

// =====================
// MEMORY LOADING
// =====================
async function loadMemory() {
  const [doctrinePages, projetsPages, decisionsPages] = await Promise.all([
    fetchLatest(DB_DOCTRINE, 10),
    fetchLatest(DB_PROJETS, 10),
    fetchLatest(DB_DECISIONS, 10),
  ]);

  return {
    doctrine: doctrinePages.map((p) => ({
      titre: extractTitleValue(p),
      type: extractRichValue(p, "Type"),
      contenu: extractRichValue(p, "Contenu"),
      version: extractRichValue(p, "Version"),
      actif: extractRichValue(p, "Actif"),
    })),
    projets: projetsPages.map((p) => ({
      titre: extractTitleValue(p),
      objectif: extractRichValue(p, "Objectif"),
      statut: extractRichValue(p, "Statut"),
      priorite: extractRichValue(p, "Priorité"),
      domaine: extractRichValue(p, "Domaine"),
    })),
    decisions: decisionsPages.map((p) => ({
      titre: extractTitleValue(p),
      statut: extractRichValue(p, "Statut"),
      domaine: extractRichValue(p, "Domaine"),
      justification: extractRichValue(p, "Justification"),
      impact: extractRichValue(p, "Impact"),
      date: extractRichValue(p, "Date"),
    })),
  };
}

// =====================
// ENUMS ALIGNÉS NOTION
// =====================
// DOCTRINE Type options (Notion "Type")
const DOCTRINE_TYPES = [
  "Positionnement",
  "Ligne rouge",
  "Méthode",
  "Structure",
  "Formation",
  "Processus interne",
  "Innovation",
  "Gouvernance",
  "Éthique et Transparence",
  "Prise de décision",
];

// DECISIONS
const DECISION_STATUTS = ["Actée", "En réflexion", "Abandonnée", "Active"];
const DECISION_DOMAINES = ["Formation", "EIRIA", "Vente", "Communication", "Organisation", "Stratégie"];

// PROJETS
const PROJET_STATUTS = ["Idée", "En cours", "En pause", "Terminé"];
const PROJET_DOMAINES = ["Formation", "EIRIA", "Vente", "Communication", "Organisation"];

// =====================
// OPENAI: STRUCTURED OUTPUT SCHEMA
// =====================
const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "type_demande",
    "domaine",
    "decision_strategique",
    "nouveau_projet",
    "priorite",
    "decision_directeur",
    "brief_valide",
    "structure_qualiopi",
    "livrable_final",
    "ecritures_notion",
    "prochaines_actions",
    "orchestration",
  ],
  properties: {
    type_demande: { type: "string" },
    domaine: { type: "string" },
    decision_strategique: { type: "boolean" },
    nouveau_projet: { type: "boolean" },
    priorite: { type: "string", enum: ["Haute", "Moyenne", "Basse"] },
    decision_directeur: { type: "string" },

    brief_valide: { type: "string" },
    structure_qualiopi: { type: "string" },
    livrable_final: { type: "string" },

    ecritures_notion: {
      type: "object",
      additionalProperties: false,
      required: ["doctrine", "decisions", "projets"],
      properties: {
        doctrine: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["titre", "categorie", "contenu", "actif", "version"],
            properties: {
              titre: { type: "string" },
              categorie: { type: "string", enum: DOCTRINE_TYPES },
              contenu: { type: "string" },
              actif: { type: "boolean" },
              version: { type: "string" },
            },
          },
        },
        decisions: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["titre", "statut", "domaine", "justification", "impact"],
            properties: {
              titre: { type: "string" },
              statut: { type: "string", enum: DECISION_STATUTS },
              domaine: { type: "string", enum: DECISION_DOMAINES },
              justification: { type: "string" },
              impact: { type: "string" },
            },
          },
        },
        projets: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["titre", "objectif", "statut", "priorite", "domaine"],
            properties: {
              titre: { type: "string" },
              objectif: { type: "string" },
              statut: { type: "string", enum: PROJET_STATUTS },
              priorite: { type: "string", enum: ["Haute", "Moyenne", "Basse"] },
              domaine: { type: "string", enum: PROJET_DOMAINES },
            },
          },
        },
      },
    },

    prochaines_actions: {
      type: "array",
      items: { type: "string" },
    },

    orchestration: {
      type: "object",
      additionalProperties: false,
      required: ["mode", "plan"],
      properties: {
        mode: { type: "string", enum: ["none", "sync"] },
        plan: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["agent", "payload"],
            properties: {
              agent: { type: "string", enum: ["formation", "contenu", "commercial"] },
              payload: {
                type: "object",
                additionalProperties: false,
                required: ["demande_client", "contexte", "contraintes", "objectif"],
                properties: {
                  demande_client: { type: "string" },
                  contexte: { type: "string" },
                  contraintes: { type: "string" },
                  objectif: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
  },
};

// =====================
// DIRECTOR PROMPT
// =====================
function buildSystemPrompt(memory, isTestMode) {
  return `
Tu es le Directeur Exécutif IA d’InnovaCSE.
Tu es le bras droit stratégique du fondateur.

RÈGLES NON NÉGOCIABLES
- Clarifier si flou.
- Imposer un choix unique si hésitation.
- Refuser la dispersion.
- Si contradiction avec une décision actée: le signaler.
- Pas de blabla. Phrases courtes. Concret.

MODE_TEST: ${isTestMode ? "TRUE" : "FALSE"}
- Si MODE_TEST = TRUE : tu dois retourner ecritures_notion.doctrine = [], ecritures_notion.decisions = [], ecritures_notion.projets = [].
- Donc AUCUNE écriture de mémoire (hors journal technique qui est géré par le serveur).

DOCTRINE INNOVACSE (OBLIGATOIRE)
- InnovaCSE = expert méthodologique CSE. La formation est un vecteur. La méthode est le cœur.
- Pas de contenu juridique encyclopédique. Pas de digressions inutiles.
- Lignes rouges: aucun conseil disciplinaire, aucune sanction, aucune qualification juridique engageante, aucune décision à la place d’un acteur, aucune reco RH organisationnelle.
- Structure pédagogique immuable: Cadre juridique -> Analyse structurée -> Outils mobilisables.

ORCHESTRATION (IMPORTANT)
- Tu peux demander l’appel d’un agent spécialisé.
- Si pas besoin: orchestration.mode="none" et plan=[]
- Si besoin: orchestration.mode="sync" et plan=[{agent, payload}]
- agent = "formation" si demande = construire / adapter / structurer une formation.
- agent = "contenu" si demande = écrire du contenu (posts, pages, scripts, supports).
- agent = "commercial" si demande = offre, pricing, séquence de vente, prospection.
- payload doit contenir EXACTEMENT: demande_client, contexte, contraintes, objectif.

MÉMOIRE NOTION (résumé, à respecter)
${JSON.stringify(memory)}

SORTIE
Tu dois produire UNIQUEMENT un JSON conforme au schéma. Aucun texte hors JSON.
`.trim();
}

// =====================
// INTERNAL AGENTS (PROMPTS)
// =====================
function agentSystemPrompt(agentKey) {
  if (agentKey === "formation") {
  return `
Tu es l’agent spécialisé FORMATION d’InnovaCSE.

OBJECTIF
Produire un PROGRAMME DÉTAILLÉ d'une journée (7h) pour directeurs :
"Recevoir un signalement sans se mettre en faute".

CONTRAINTES
- Pas de qualification juridique engageante.
- Pas de conseil disciplinaire / sanction.
- On reste sur posture, méthode, sécurisation, traçabilité, limites de rôle.
- Pas de blabla. Pas de phrases vagues.

FORMAT OBLIGATOIRE DU LIVRABLE (dans le champ livrable)
1) Titre + public + prérequis + durée
2) Objectifs pédagogiques (5 max)
3) Déroulé horaire précis (08:30–17:00) avec : objectif de séquence + contenu + méthode (exposé / groupe / jeu de rôle) + livrable attendu
4) Ateliers (minimum 3) — pour chaque atelier :
   - scénario de départ (2–3 lignes)
   - consignes exactes
   - production attendue (document / grille / décision de process)
   - critères de réussite
5) Liste des supports à préparer (grilles, fiches, modèles de compte-rendu)
6) Points à valider (liste)

RÈGLE ANTI-GÉNÉRIQUE
- Interdit d’écrire "obligations légales" sans préciser : "principes / interdictions / protections / limites" (sans citer d’articles).
- Le livrable doit faire au minimum 1200 caractères.

SORTIE: JSON uniquement.
Schéma:
{
  "agent":"formation",
  "livrable":"string",
  "points_a_valider":["string", "..."]
}
`.trim();
}
  if (agentKey === "contenu") {
    return `
Tu es l’agent spécialisé CONTENU d’InnovaCSE.
Tu produis des textes prêts à publier (ou supports), structurés et courts.
Pas de blabla. Pas d’approximation juridique.
SORTIE: JSON uniquement.
Schéma:
{
  "agent":"contenu",
  "livrable":"string",
  "formats":["string", "..."],
  "points_a_valider":["string", "..."]
}
`.trim();
  }
  // commercial
  return `
Tu es l’agent spécialisé COMMERCIAL d’InnovaCSE.
Tu produis des éléments concrets (offre, positionnement, pitch, objections, séquence).
Pas de blabla. Pas de jargon.
SORTIE: JSON uniquement.
Schéma:
{
  "agent":"commercial",
  "livrable":"string",
  "points_a_valider":["string", "..."]
}
`.trim();
}

async function callSpecialist(agentKey, payload) {
  const SYSTEM = agentSystemPrompt(agentKey);
  const userContent = JSON.stringify(payload ?? {}, null, 2);

  const r = await openai.responses.create({
    model: "gpt-4.1-mini",
    temperature: 0.2,
    input: [
      { role: "system", content: SYSTEM },
      { role: "user", content: userContent },
    ],
  });

  const raw = (r.output_text || "").trim();
  if (!raw) return { ok: false, agent: agentKey, error: "EMPTY_AGENT_OUTPUT" };

  try {
    const json = JSON.parse(raw);
    return { ok: true, agent: agentKey, data: json };
  } catch {
    // fallback si l'agent ne respecte pas JSON-only
    return {
      ok: true,
      agent: agentKey,
      data: { agent: agentKey, livrable: raw, points_a_valider: [] },
    };
  }
}

// =====================
// ROUTES
// =====================
app.get("/", (req, res) => res.status(200).send("OK"));

app.get("/debug-env", (req, res) => {
  res.json({
    hasOpenAI: !!process.env.OPENAI_API_KEY,
    hasNotionToken: !!process.env.NOTION_TOKEN,
    dbJournal: process.env.NOTION_DB_JOURNAL_AGENT_DIRECTEUR || null,
    dbDoctrine: process.env.NOTION_DB_DOCTRINE_VIVANTE || null,
    dbProjets: process.env.NOTION_DB_PROJETS || null,
    dbDecisions: process.env.NOTION_DB_DECISIONS_STRATEGIQUES || null,
  });
});

// --- Internal agent routes
app.post("/agents/formation", async (req, res) => {
  try {
    const out = await callSpecialist("formation", req.body || {});
    return res.json(out);
  } catch (err) {
    return res.status(500).json({ ok: false, agent: "formation", error: String(err?.message || err) });
  }
});

app.post("/agents/contenu", async (req, res) => {
  try {
    const out = await callSpecialist("contenu", req.body || {});
    return res.json(out);
  } catch (err) {
    return res.status(500).json({ ok: false, agent: "contenu", error: String(err?.message || err) });
  }
});

app.post("/agents/commercial", async (req, res) => {
  try {
    const out = await callSpecialist("commercial", req.body || {});
    return res.json(out);
  } catch (err) {
    return res.status(500).json({ ok: false, agent: "commercial", error: String(err?.message || err) });
  }
});

app.post("/run", async (req, res) => {
  try {
    const { demande_client = "", contexte = "", contraintes = "", mode_test = false } = req.body || {};

    const isTestMode =
      Boolean(mode_test) ||
      String(demande_client || "").toUpperCase().startsWith("TEST TECH");

    // Load memory from Notion
    const memory = await loadMemory();
    const SYSTEM = buildSystemPrompt(memory, isTestMode);

    const userContent = `
DEMANDE CLIENT:
${demande_client}

CONTEXTE:
${contexte}

CONTRAINTES:
${contraintes}
`.trim();

    // OpenAI call with strict structured output
    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      temperature: 0.2,
      input: [
        { role: "system", content: SYSTEM },
        { role: "user", content: userContent },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "innovacse_directeur",
          strict: true,
          schema: OUTPUT_SCHEMA,
        },
      },
    });

    const raw = (response.output_text || "").trim();
    if (!raw) throw new Error("Empty model output_text");

    const data = JSON.parse(raw);

// =====================
// ORCHESTRATION FORCÉE (sécurité)
// =====================
if (!isTestMode) {
  const txt = `${demande_client} ${contexte} ${contraintes}`.toLowerCase();

  const shouldForceFormation =
    (data?.domaine && String(data.domaine).toLowerCase().includes("formation")) ||
    txt.includes("formation") ||
    txt.includes("programme") ||
    txt.includes("journée") ||
    txt.includes("directeur");

  if (shouldForceFormation && (!data.orchestration || data.orchestration.mode !== "sync")) {
    data.orchestration = {
      mode: "sync",
      plan: [
        {
          agent: "formation",
          payload: {
            demande_client: demande_client || "Demande formation",
            contexte: contexte || "",
            contraintes: contraintes || "",
            objectif: "Programme structuré, ateliers cadrés, livrables attendus, prêt à déployer",
          },
        },
      ],
    };
  }
}
    
    // Hard safety: even if model fails instruction, we sanitize in test mode
    if (isTestMode) {
      data.ecritures_notion = { doctrine: [], decisions: [], projets: [] };
      data.orchestration = { mode: "none", plan: [] };
    }

    // Execute orchestration (internal agents) only if NOT test mode
    let orchestration_results = [];
    if (!isTestMode && data.orchestration?.mode === "sync" && Array.isArray(data.orchestration?.plan)) {
      for (const step of data.orchestration.plan) {
        const agentKey = step?.agent;
        if (!agentKey) continue;

        // payload est strictement limité par le schema
        const payload = step?.payload || {};

        // IMPORTANT: ne pas ajouter de clés supplémentaires (schema strict)
        const safePayload = {
          demande_client: payload.demande_client ?? demande_client,
          contexte: payload.contexte ?? contexte,
          contraintes: payload.contraintes ?? contraintes,
          objectif: payload.objectif ?? (data.livrable_final || data.decision_directeur || ""),
        };

        const r = await callSpecialist(agentKey, safePayload);
        orchestration_results.push(r);
      }
    }

    // MODE B: absorption du livrable agent dans livrable_final
    if (!isTestMode) {
      const agentLivrable = extractAgentLivrable(orchestration_results);
      if (agentLivrable) {
        data.livrable_final = agentLivrable;
      }
    }

    // Get DB metas
    const [mJournal, mDoctrine, mProjets, mDecisions] = await Promise.all([
      getDbMeta(DB_JOURNAL),
      getDbMeta(DB_DOCTRINE),
      getDbMeta(DB_PROJETS),
      getDbMeta(DB_DECISIONS),
    ]);

    const nowIso = new Date().toISOString();

    // 1) JOURNAL_AGENT_DIRECTEUR (toujours)
    const journalProps = {
      [mJournal.titleProp]: titleProp(demande_client || "Run IA"),
    };

    if (mJournal.props["Date"]?.type === "date") journalProps["Date"] = dateProp(nowIso);
    if (mJournal.props["Résultat produit"]?.type === "rich_text")
      journalProps["Résultat produit"] = rich(data.livrable_final);
    if (mJournal.props["Décision prise"]?.type === "rich_text")
      journalProps["Décision prise"] = rich(data.decision_directeur);
    if (mJournal.props["Prochaine action"]?.type === "rich_text") {
      journalProps["Prochaine action"] = rich((data.prochaines_actions || []).join(" | "), 1900);
    }

    // Agents mobilisés (Directeur + agents réellement appelés)
    if (mJournal.props["Agents mobilisés"]?.type === "multi_select") {
      const called = (orchestration_results || []).map((x) => x?.agent).filter(Boolean);
      const ms = safeMultiSelect(mJournal, "Agents mobilisés", ["Directeur", ...called].filter(Boolean));
      if (ms) journalProps["Agents mobilisés"] = ms;
    }

    // Résultats agents (si la colonne existe)
    if (mJournal.props["Résultats agents"]?.type === "rich_text") {
      journalProps["Résultats agents"] = rich(JSON.stringify(orchestration_results).slice(0, 1900));
    }

    await notion.pages.create({
      parent: { database_id: DB_JOURNAL },
      properties: journalProps,
    });

    // 2) DOCTRINE_VIVANTE
    for (const d of data.ecritures_notion?.doctrine || []) {
      const props = {
        [mDoctrine.titleProp]: titleProp(d.titre),
      };

      if (mDoctrine.props["Contenu"]?.type === "rich_text") props["Contenu"] = rich(d.contenu);
      if (mDoctrine.props["Version"]?.type === "rich_text") props["Version"] = rich(d.version ?? "V1");

      if (mDoctrine.props["Type"]?.type === "select") {
        const s = safeSelect(mDoctrine, "Type", d.categorie);
        if (s) props["Type"] = s;
      }

      if (mDoctrine.props["Actif"]?.type === "checkbox") props["Actif"] = { checkbox: !!d.actif };

      await notion.pages.create({
        parent: { database_id: DB_DOCTRINE },
        properties: props,
      });
    }

    // 3) DECISIONS_STRATEGIQUES
    for (const s of data.ecritures_notion?.decisions || []) {
      const props = {
        [mDecisions.titleProp]: titleProp(s.titre),
      };

      if (mDecisions.props["Date"]?.type === "date") props["Date"] = dateProp(nowIso);
      if (mDecisions.props["Justification"]?.type === "rich_text") props["Justification"] = rich(s.justification);
      if (mDecisions.props["Impact"]?.type === "rich_text") props["Impact"] = rich(s.impact);

      if (mDecisions.props["Statut"]?.type === "select") {
        const sel = safeSelect(mDecisions, "Statut", s.statut);
        if (sel) props["Statut"] = sel;
      }
      if (mDecisions.props["Domaine"]?.type === "select") {
        const sel = safeSelect(mDecisions, "Domaine", s.domaine);
        if (sel) props["Domaine"] = sel;
      }

      await notion.pages.create({
        parent: { database_id: DB_DECISIONS },
        properties: props,
      });
    }

    // 4) PROJETS (écritures issues du modèle)
for (const p of data.ecritures_notion?.projets || []) {
  const props = {
    [mProjets.titleProp]: titleProp(p.titre),
  };

  if (mProjets.props["Objectif"]?.type === "rich_text") {
    props["Objectif"] = rich(p.objectif);
  }

  if (mProjets.props["Statut"]?.type === "select") {
    const sel = safeSelect(mProjets, "Statut", p.statut);
    if (sel) props["Statut"] = sel;
  }

  if (mProjets.props["Priorité"]?.type === "select") {
    const sel = safeSelect(mProjets, "Priorité", p.priorite);
    if (sel) props["Priorité"] = sel;
  }

  if (mProjets.props["Domaine"]?.type === "select") {
    const sel = safeSelect(mProjets, "Domaine", p.domaine);
    if (sel) props["Domaine"] = sel;
  }

  const projectTitle = `Programme formation — ${demande_client.slice(0, 60)}`;

// (re)force le titre utilisé pour la recherche + écriture
props[mProjets.titleProp] = titleProp(projectTitle);

const existingId = await findPageIdByExactTitle(DB_PROJETS, mProjets.titleProp, projectTitle);

if (existingId) {
  await notion.pages.update({
    page_id: existingId,
    properties: props,
  });
} else {
  await notion.pages.create({
    parent: { database_id: DB_PROJETS },
    properties: props,
  });
}

// =====================
// PROJET AUTO — Formation
// =====================
if (
  !isTestMode &&
  data?.domaine === "Formation" &&
  data?.nouveau_projet === true
) {
  const props = {
    [mProjets.titleProp]: titleProp(
      `Programme formation — ${demande_client.slice(0, 60)}`
    ),
  };

  if (mProjets.props["Objectif"]?.type === "rich_text") {
    props["Objectif"] = rich(data.livrable_final);
  }

  if (mProjets.props["Statut"]?.type === "select") {
    const sel = safeSelect(mProjets, "Statut", "En cours");
    if (sel) props["Statut"] = sel;
  }

  if (mProjets.props["Priorité"]?.type === "select") {
    const sel = safeSelect(mProjets, "Priorité", data.priorite || "Moyenne");
    if (sel) props["Priorité"] = sel;
  }

  if (mProjets.props["Domaine"]?.type === "select") {
    const sel = safeSelect(mProjets, "Domaine", "Formation");
    if (sel) props["Domaine"] = sel;
  }

  await notion.pages.create({
    parent: { database_id: DB_PROJETS },
    properties: props,
  });
}

    return res.json({ ok: true, data, orchestration_results, mode_test: isTestMode });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// =====================
// START
// =====================
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on ${port}`));
