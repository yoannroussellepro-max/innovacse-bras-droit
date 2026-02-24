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
// Notion property names (AJUSTE SI BESOIN)
// =====================
// Journal
const PROP_J_TITLE = "Nom";
const PROP_J_DATE = "Date";
const PROP_J_DECISION = "Décision prise";
const PROP_J_AGENTS = "Agents mobilisés";
const PROP_J_RESULT = "Résultat produit";
const PROP_J_NEXT = "Prochaine action";

// Doctrine (DOCTRINE_VIVANTE)
const PROP_D_TITLE = "Nom";      // title
const PROP_D_RULE = "Version";   // rich_text (contenu)
const PROP_D_CATEGORY = "Type";  // select (catégorie)
const PROP_D_ACTIVE = "Actif";   // checkbox

// Projets
const PROP_P_TITLE = "Nom";
const PROP_P_STATUS = "Statut";        // optional
const PROP_P_PRIORITY = "Priorité";    // optional
const PROP_P_OBJECTIF = "Objectif";    // optional
const PROP_P_NEXT = "Prochaines actions"; // optional
const PROP_P_DUE = "Échéance";         // optional
const PROP_P_UPDATED = "Dernière MAJ"; // optional

// Décisions
const PROP_S_TITLE = "Nom";
const PROP_S_DATE = "Date";            // optional
const PROP_S_DECISION = "Décision";    // optional
const PROP_S_CONTEXTE = "Contexte";    // optional
const PROP_S_RATIONALE = "Rationale";  // optional
const PROP_S_STATUS = "Statut";        // optional

// =====================
// Clients
// =====================
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const notion = new NotionClient({ auth: NOTION_TOKEN });

// =====================
// Helpers Notion property builders
// =====================
function rt(text) {
  return { rich_text: [{ text: { content: String(text || "").slice(0, 1900) } }] };
}
function title(text) {
  return { title: [{ text: { content: String(text || "").slice(0, 120) } }] };
}
function dateProp(iso) {
  return { date: { start: iso } };
}
function select(name) {
  return name ? { select: { name } } : undefined;
}
function multiSelect(names) {
  return { multi_select: (names || []).filter(Boolean).map((n) => ({ name: n })) };
}

// Safe set property if value exists
function setIf(obj, key, value) {
  if (value === undefined || value === null) return;
  obj[key] = value;
}

// =====================
// Read memory from Notion (latest items)
// =====================
async function fetchLatestFromDb(database_id, pageSize = 10) {
  const res = await notion.databases.query({
    database_id,
    page_size: pageSize,
    sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
  });
  return res.results || [];
}

function extractTitle(page, fallback = "") {
  const props = page?.properties || {};
  for (const k of Object.keys(props)) {
    if (props[k]?.type === "title") {
      const arr = props[k]?.title || [];
      return arr.map((t) => t?.plain_text || "").join("").trim() || fallback;
    }
  }
  return fallback;
}

function extractRichText(page, propName) {
  const p = page?.properties?.[propName];
  if (!p) return "";
  if (p.type === "rich_text") return (p.rich_text || []).map((t) => t.plain_text || "").join("").trim();
  if (p.type === "title") return (p.title || []).map((t) => t.plain_text || "").join("").trim();
  return "";
}

function compactPage(page, wantedProps = []) {
  const name = extractTitle(page, "");
  const out = { name };
  for (const prop of wantedProps) {
    out[prop] = extractRichText(page, prop);
  }
  out.last_edited_time = page.last_edited_time;
  return out;
}

async function loadMemorySnapshot() {
  const [doctrinePages, projetsPages, decisionsPages] = await Promise.all([
    fetchLatestFromDb(DB_DOCTRINE, 12),
    fetchLatestFromDb(DB_PROJETS, 12),
    fetchLatestFromDb(DB_DECISIONS, 12),
  ]);

  const doctrine = doctrinePages.map((p) =>
    compactPage(p, [PROP_D_RULE, PROP_D_CATEGORY, PROP_D_STATUS])
  );
  const projets = projetsPages.map((p) =>
    compactPage(p, [PROP_P_STATUS, PROP_P_PRIORITY, PROP_P_OBJECTIF, PROP_P_NEXT])
  );
  const decisions = decisionsPages.map((p) =>
    compactPage(p, [PROP_S_DECISION, PROP_S_CONTEXTE, PROP_S_RATIONALE, PROP_S_STATUS])
  );

  return { doctrine, projets, decisions };
}

// =====================
// System prompt (Directeur + sous-agents + mémoire)
// =====================
function buildSystemPrompt(memorySnapshot) {
  return `
Tu es le DIRECTEUR IA d’InnovaCSE.
Tu es le chef d’orchestre. Tu clarifies, tu arbitres, tu structures, tu mobilises des sous-agents, tu produis, et tu proposes des écritures Notion.

DOCTRINE (obligatoire)
- InnovaCSE = expert méthodologique CSE/SSCT. La formation est un vecteur, la méthode est le cœur.
- Sorties : concrètes, structurées, actionnables. Pas de digressions juridiques encyclopédiques.
- Lignes rouges : jamais conseil disciplinaire, sanction, qualification juridique engageante, remplacement employeur, recommandations RH d’organisation.
  Formules autorisées : “Le cadre légal prévoit…”, “Le CSE peut…”, “La décision relève de…”. Jamais : “Vous devez…”.
- Style : phrases courtes. Zéro blabla. Une colonne vertébrale.

SOUS-AGENTS (tu les simules, tu restes décideur)
A Formation (Qualiopi)
B Process/Workflow
C Produit/Offres
D Vente/Positionnement
E Communication
F Veille (sans inventer : indique ce qu’il faut vérifier)
G Qualité/Conformité (lignes rouges + structure)

MÉMOIRE DISPONIBLE (Notion, extrait récent)
DOCTRINE_VIVANTE (résumé):
${JSON.stringify(memorySnapshot.doctrine, null, 2)}

PROJETS (résumé):
${JSON.stringify(memorySnapshot.projets, null, 2)}

DECISIONS_STRATEGIQUES (résumé):
${JSON.stringify(memorySnapshot.decisions, null, 2)}

PROCESSUS (ordre immuable)
1) CHEF : produire BRIEF_VALIDÉ (si manque info : فرض une hypothèse unique et l’indiquer).
2) ARCHITECTE : produire PLAN_D’ORCHESTRATION (agents mobilisés + objectifs + livrables).
3) PRODUCTION : produire par agents (sections séparées) + synthèse directeur.
4) QUALITÉ : contrôle final.
5) MÉMOIRE : proposer écritures Notion (journal + doctrine + décisions + projets).
6) NEXT ACTIONS : 3–7 actions.

FORMAT DE SORTIE
JSON strict uniquement, clés :
- brief_valide (string)
- plan_agents (string)
- livrable_final (string)
- ecritures_notion (object) :
  - journal (string)
  - doctrine (array of objects) { titre, categorie, statut, contenu }
  - decisions (array of objects) { titre, decision, contexte, rationale, statut }
  - projets (array of objects) { titre, statut, priorite, objectif, prochaines_actions }
- prochaines_actions (array of strings)
Aucun texte hors JSON.
`.trim();
}

// =====================
// Notion writes
// =====================
async function writeJournal({ demande_client, data }) {
  const now = new Date().toISOString();
  const props = {};
  props[PROP_J_TITLE] = title((demande_client || "Run IA").slice(0, 90));
  setIf(props, PROP_J_DATE, dateProp(now));
  setIf(props, PROP_J_DECISION, rt("Run Directeur (lecture mémoire → orchestration → écriture multi-bases)"));
  setIf(props, PROP_J_AGENTS, multiSelect(["Directeur", "Formation", "Process", "Produit", "Vente", "Communication", "Veille", "Qualité"]));
  setIf(props, PROP_J_RESULT, rt(data?.livrable_final || ""));
  setIf(props, PROP_J_NEXT, rt((data?.prochaines_actions || []).join(" | ")));

  await notion.pages.create({
    parent: { database_id: DB_JOURNAL },
    properties: props,
  });
}

async function writeDoctrine(items) {
  if (!Array.isArray(items) || items.length === 0) return;
  const now = new Date().toISOString();
  for (const it of items) {
    const props = {};
    props[PROP_D_TITLE] = title(it.titre || "Règle");
    setIf(props, PROP_D_RULE, rt(it.contenu || ""));
    setIf(props, PROP_D_CATEGORY, select(it.categorie));
    setIf(props, PROP_D_STATUS, select(it.statut));
    setIf(props, PROP_D_DATE, dateProp(now));
    await notion.pages.create({ parent: { database_id: DB_DOCTRINE }, properties: props });
  }
}

async function writeDecisions(items) {
  if (!Array.isArray(items) || items.length === 0) return;
  const now = new Date().toISOString();
  for (const it of items) {
    const props = {};
    props[PROP_S_TITLE] = title(it.titre || "Décision");
    setIf(props, PROP_S_DATE, dateProp(now));
    setIf(props, PROP_S_DECISION, rt(it.decision || ""));
    setIf(props, PROP_S_CONTEXTE, rt(it.contexte || ""));
    setIf(props, PROP_S_RATIONALE, rt(it.rationale || ""));
    setIf(props, PROP_S_STATUS, select(it.statut || "Active"));
    await notion.pages.create({ parent: { database_id: DB_DECISIONS }, properties: props });
  }
}

async function writeProjects(items) {
  if (!Array.isArray(items) || items.length === 0) return;
  const now = new Date().toISOString();
  for (const it of items) {
    const props = {};
    props[PROP_P_TITLE] = title(it.titre || "Projet");
    setIf(props, PROP_P_STATUS, select(it.statut));
    setIf(props, PROP_P_PRIORITY, select(it.priorite));
    setIf(props, PROP_P_OBJECTIF, rt(it.objectif || ""));
    setIf(props, PROP_P_NEXT, rt(it.prochaines_actions || ""));
    setIf(props, PROP_P_UPDATED, dateProp(now));
    await notion.pages.create({ parent: { database_id: DB_PROJETS }, properties: props });
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
    dbJournal: DB_JOURNAL,
    dbDoctrine: DB_DOCTRINE,
    dbProjets: DB_PROJETS,
    dbDecisions: DB_DECISIONS,
  });
});

app.post("/run", async (req, res) => {
  try {
    const { demande_client, contexte, contraintes } = req.body || {};

    // 1) Lecture mémoire Notion
    const memory = await loadMemorySnapshot();

    // 2) Construction prompt directeur
    const SYSTEM = buildSystemPrompt(memory);

    const userInput =
`DEMANDE CLIENT:
${demande_client || ""}

CONTEXTE:
${contexte || ""}

CONTRAINTES:
${contraintes || ""}`.trim();

    // 3) Appel OpenAI
    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      temperature: 0.2,
      input: [
        { role: "system", content: SYSTEM },
        { role: "user", content: userInput },
      ],
    });

    const out = response.output_text?.trim() || "";
    let data;
    try {
      data = JSON.parse(out);
    } catch {
      // Si JSON pas strict : on renvoie une erreur (pas de write Notion incohérent)
      return res.status(500).json({
        ok: false,
        error: "Model did not return strict JSON",
        raw: out.slice(0, 4000),
      });
    }

    // 4) Écritures Notion (journal + autres)
    await writeJournal({ demande_client, data });

    const e = data.ecritures_notion || {};
    await writeDoctrine(e.doctrine || []);
    await writeDecisions(e.decisions || []);
    await writeProjects(e.projets || []);

    return res.json({ ok: true, data });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: String(err?.message || err),
    });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on ${port}`));
