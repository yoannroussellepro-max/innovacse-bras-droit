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
// NOTION PROPERTY MAPPING
// =====================

// Journal
const PROP_J_TITLE = "Nom";
const PROP_J_DATE = "Date";
const PROP_J_RESULT = "Résultat produit";

// Doctrine
const PROP_D_TITLE = "Nom";
const PROP_D_RULE = "Version";
const PROP_D_CATEGORY = "Type";
const PROP_D_ACTIVE = "Actif";

// Projets (écriture minimale sûre)
const PROP_P_TITLE = "Nom";
const PROP_P_OBJECTIF = "Objectif";

// Décisions
const PROP_S_TITLE = "Nom";
const PROP_S_DATE = "date";
const PROP_S_STATUS = "statut";
const PROP_S_JUSTIFICATION = "justification";
const PROP_S_DOMAINE = "domaine";

// =====================
// CLIENTS
// =====================
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const notion = new NotionClient({ auth: NOTION_TOKEN });

// =====================
// HELPERS
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

// =====================
// LECTURE MÉMOIRE
// =====================
async function fetchLatest(database_id) {
  const res = await notion.databases.query({
    database_id,
    page_size: 10,
    sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
  });
  return res.results || [];
}

function extractTitle(page) {
  const props = page.properties;
  for (const key in props) {
    if (props[key].type === "title") {
      return props[key].title.map(t => t.plain_text).join("");
    }
  }
  return "";
}

function extractRich(page, prop) {
  const p = page.properties[prop];
  if (!p) return "";
  if (p.type === "rich_text") return p.rich_text.map(t => t.plain_text).join("");
  if (p.type === "title") return p.title.map(t => t.plain_text).join("");
  return "";
}

async function loadMemory() {
  const [doctrine, projets, decisions] = await Promise.all([
    fetchLatest(DB_DOCTRINE),
    fetchLatest(DB_PROJETS),
    fetchLatest(DB_DECISIONS),
  ]);

  return {
    doctrine: doctrine.map(p => ({
      nom: extractTitle(p),
      type: extractRich(p, PROP_D_CATEGORY),
      contenu: extractRich(p, PROP_D_RULE),
    })),
    projets: projets.map(p => ({
      nom: extractTitle(p),
      objectif: extractRich(p, PROP_P_OBJECTIF),
    })),
    decisions: decisions.map(p => ({
      nom: extractTitle(p),
      statut: extractRich(p, PROP_S_STATUS),
      domaine: extractRich(p, PROP_S_DOMAINE),
      justification: extractRich(p, PROP_S_JUSTIFICATION),
    })),
  };
}
// =====================
// PROMPT
// =====================
function buildSystemPrompt(memory) {
  return `
Tu es le DIRECTEUR IA d’InnovaCSE.

Tu lis la mémoire stratégique et tu décides avec continuité.

MÉMOIRE ACTUELLE :
DOCTRINE: ${JSON.stringify(memory.doctrine)}
PROJETS: ${JSON.stringify(memory.projets)}
DECISIONS: ${JSON.stringify(memory.decisions)}

Réponds UNIQUEMENT en JSON strict :

{
  "brief_valide": "...",
  "plan_agents": "...",
  "livrable_final": "...",
  "ecritures_notion": {
    "doctrine": [{ "titre": "...", "categorie": "...", "contenu": "..." }],
    "decisions": [{ "titre": "...", "decision": "...", "rationale": "...", "statut": "Active", "domaine": "Stratégie" }],
    "projets": [{ "titre": "...", "objectif": "..." }]
  },
  "prochaines_actions": ["...", "..."]
}
`.trim();
}

// =====================
// ROUTES
// =====================
app.get("/", (req, res) => res.send("OK"));

app.post("/run", async (req, res) => {
  try {
    const { demande_client, contexte, contraintes } = req.body;

    const memory = await loadMemory();
    const SYSTEM = buildSystemPrompt(memory);

    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      temperature: 0.2,
      input: [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: `
DEMANDE: ${demande_client}
CONTEXTE: ${contexte}
CONTRAINTES: ${contraintes}
`
        }
      ],
    });

    const out = response.output_text?.trim();
    const data = JSON.parse(out);

    // JOURNAL
    await notion.pages.create({
      parent: { database_id: DB_JOURNAL },
      properties: {
        [PROP_J_TITLE]: title(demande_client),
        [PROP_J_DATE]: dateProp(new Date().toISOString()),
        [PROP_J_RESULT]: rt(data.livrable_final),
      }
    });

    // DOCTRINE
    for (const d of data.ecritures_notion?.doctrine || []) {
      await notion.pages.create({
        parent: { database_id: DB_DOCTRINE },
        properties: {
          [PROP_D_TITLE]: title(d.titre),
          [PROP_D_RULE]: rt(d.contenu),
          [PROP_D_CATEGORY]: select(d.categorie),
          [PROP_D_ACTIVE]: { checkbox: true }
        }
      });
    }

    // DECISIONS
for (const s of data.ecritures_notion?.decisions || []) {
  const props = {
    [PROP_S_TITLE]: title(s.titre),
    [PROP_S_JUSTIFICATION]: rt(s.rationale || s.justification || s.decision || ""),
    [PROP_S_DATE]: dateProp(new Date().toISOString()),
  };

  if (s.statut) props[PROP_S_STATUS] = select(s.statut);
  if (s.domaine) props[PROP_S_DOMAINE] = select(s.domaine);

  await notion.pages.create({
    parent: { database_id: DB_DECISIONS },
    properties: props,
  });
}
    // PROJETS
    for (const p of data.ecritures_notion?.projets || []) {
      await notion.pages.create({
        parent: { database_id: DB_PROJETS },
        properties: {
          [PROP_P_TITLE]: title(p.titre),
          [PROP_P_OBJECTIF]: rt(p.objectif),
        }
      });
    }

    res.json({ ok: true, data });

  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});
