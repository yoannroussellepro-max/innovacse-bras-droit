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
  let titleProp = null;
  for (const [name, def] of Object.entries(props)) {
    if (def.type === "title") {
      titleProp = name;
      break;
    }
  }
  if (!titleProp) throw new Error(`No title property found for DB ${database_id}`);

  // Build select options sets
  const selectOptions = new Map();
  for (const [name, def] of Object.entries(props)) {
    if (def.type === "select") {
      selectOptions.set(name, new Set((def.select?.options || []).map(o => o.name)));
    }
    if (def.type === "multi_select") {
      selectOptions.set(name, new Set((def.multi_select?.options || []).map(o => o.name)));
    }
  }

  const meta = { titleProp, props, selectOptions };
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
    .filter(v => typeof v === "string" && set.has(v))
    .map(v => ({ name: v }));

  if (filtered.length === 0) return null;
  return { multi_select: filtered };
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
    if (p?.type === "title") return (p.title || []).map(t => t.plain_text).join("");
  }
  return "";
}

function extractRichValue(page, propName) {
  const p = page.properties?.[propName];
  if (!p) return "";

  if (p.type === "rich_text") return (p.rich_text || []).map(t => t.plain_text).join("");
  if (p.type === "title") return (p.title || []).map(t => t.plain_text).join("");
  if (p.type === "select") return p.select?.name || "";
  if (p.type === "multi_select") return (p.multi_select || []).map(o => o.name).join(", ");
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

  // NOTE: on lit de façon tolérante : on prend ce qui est trouvable
  return {
    doctrine: doctrinePages.map(p => ({
      titre: extractTitleValue(p),
      type: extractRichValue(p, "Type"),
      version: extractRichValue(p, "Version"),
      actif: extractRichValue(p, "Actif"),
    })),
    projets: projetsPages.map(p => ({
      titre: extractTitleValue(p),
      objectif: extractRichValue(p, "Objectif"),
      statut: extractRichValue(p, "Statut"),
      priorite: extractRichValue(p, "Priorité"),
      domaine: extractRichValue(p, "Domaine"),
    })),
    decisions: decisionsPages.map(p => ({
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
    "prochaines_actions"
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
            required: ["titre", "categorie", "contenu", "actif"],
            properties: {
              titre: { type: "string" },
              categorie: { type: "string" },
              contenu: { type: "string" },
              actif: { type: "boolean" }
            }
          }
        },
        decisions: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["titre", "statut", "domaine", "justification", "impact"],
            properties: {
              titre: { type: "string" },
              statut: { type: "string" },
              domaine: { type: "string" },
              justification: { type: "string" },
              impact: { type: "string" }
            }
          }
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
              statut: { type: "string" },
              priorite: { type: "string" },
              domaine: { type: "string" }
            }
          }
        }
      }
    },

    prochaines_actions: {
      type: "array",
      items: { type: "string" }
    }
  }
};

// =====================
// DIRECTOR PROMPT
// =====================
function buildSystemPrompt(memory) {
  return `
Tu es le Directeur Exécutif IA d’InnovaCSE.
Tu es le bras droit stratégique du fondateur.

RÈGLES NON NÉGOCIABLES
- Clarifier si flou.
- Imposer un choix unique si hésitation.
- Refuser la dispersion.
- Si contradiction avec une décision actée: le signaler.
- Pas de blabla. Phrases courtes. Concret.

DOCTRINE INNOVACSE (OBLIGATOIRE)
- InnovaCSE = expert méthodologique CSE. La formation est un vecteur. La méthode est le cœur.
- Pas de contenu juridique encyclopédique. Pas de digressions inutiles.
- Lignes rouges: aucun conseil disciplinaire, aucune sanction, aucune qualification juridique engageante, aucune décision à la place d’un acteur, aucune reco RH organisationnelle.
- Structure pédagogique immuable: Cadre juridique -> Analyse structurée -> Outils mobilisables.

MÉMOIRE NOTION (résumé, à respecter)
${JSON.stringify(memory)}

SORTIE
Tu dois produire UNIQUEMENT un JSON conforme au schéma. Aucun texte hors JSON.
`.trim();
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

app.post("/run", async (req, res) => {
  try {
    const { demande_client = "", contexte = "", contraintes = "" } = req.body || {};

    // Load memory from Notion
    const memory = await loadMemory();
    const SYSTEM = buildSystemPrompt(memory);

    const userContent =
`DEMANDE CLIENT:
${demande_client}

CONTEXTE:
${contexte}

CONTRAINTES:
${contraintes}`.trim();

    // OpenAI call with strict structured output
    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      temperature: 0.2,
      input: [
        { role: "system", content: SYSTEM },
        { role: "user", content: userContent }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "innovacse_directeur",
          strict: true,
          schema: OUTPUT_SCHEMA
        }
      }
    });

    const raw = (response.output_text || "").trim();
    const data = JSON.parse(raw);

    // Get DB metas (auto-detect title prop + select options)
    const [mJournal, mDoctrine, mProjets, mDecisions] = await Promise.all([
      getDbMeta(DB_JOURNAL),
      getDbMeta(DB_DOCTRINE),
      getDbMeta(DB_PROJETS),
      getDbMeta(DB_DECISIONS),
    ]);

    const nowIso = new Date().toISOString();

    // 1) JOURNAL_AGENT_DIRECTEUR (écriture minimale sûre)
    // Champs attendus (si existent): Date / Résultat produit / Décision prise / Agents mobilisés / Prochaine action
    // On écrit au minimum: Title + Date + Résultat produit
    const journalProps = {
      [mJournal.titleProp]: titleProp(demande_client || "Run IA"),
    };

    if (mJournal.props["Date"]?.type === "date") journalProps["Date"] = dateProp(nowIso);
    if (mJournal.props["Résultat produit"]?.type === "rich_text") journalProps["Résultat produit"] = rich(data.livrable_final);
    if (mJournal.props["Décision prise"]?.type === "rich_text") journalProps["Décision prise"] = rich(data.decision_directeur);
    if (mJournal.props["Prochaine action"]?.type === "rich_text") {
      journalProps["Prochaine action"] = rich((data.prochaines_actions || []).join(" | "), 1900);
    }
    if (mJournal.props["Agents mobilisés"]?.type === "multi_select") {
      // on met au moins "Directeur" si l'option existe
      const ms = safeMultiSelect(mJournal, "Agents mobilisés", ["Directeur", data.domaine].filter(Boolean));
      if (ms) journalProps["Agents mobilisés"] = ms;
    }

    await notion.pages.create({
      parent: { database_id: DB_JOURNAL },
      properties: journalProps
    });

    // 2) DOCTRINE_VIVANTE (si ecritures demandées)
for (const d of (data.ecritures_notion?.doctrine || [])) {
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
    properties: props
  });
}
    // 3) DECISIONS_STRATEGIQUES (si ecritures demandées)
    for (const s of (data.ecritures_notion?.decisions || [])) {
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
        properties: props
      });
    }

    // 4) PROJETS (si ecritures demandées)
    for (const p of (data.ecritures_notion?.projets || [])) {
      const props = {
        [mProjets.titleProp]: titleProp(p.titre),
      };

      if (mProjets.props["Objectif"]?.type === "rich_text") props["Objectif"] = rich(p.objectif);

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

      await notion.pages.create({
        parent: { database_id: DB_PROJETS },
        properties: props
      });
    }

    return res.json({ ok: true, data });

  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// =====================
// START
// =====================
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on ${port}`));
