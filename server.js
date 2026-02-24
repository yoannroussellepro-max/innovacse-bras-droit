import express from "express";
import OpenAI from "openai";
import { Client as NotionClient } from "@notionhq/client";

const app = express();
app.use(express.json({ limit: "1mb" }));

// ENV
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const NOTION_TOKEN = process.env.NOTION_TOKEN;

// Notion DB IDs (tes 4 bases)
const DB_JOURNAL = process.env.NOTION_DB_JOURNAL_AGENT_DIRECTEUR;

if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
if (!NOTION_TOKEN) throw new Error("Missing NOTION_TOKEN");
if (!DB_JOURNAL) throw new Error("Missing NOTION_DB_JOURNAL_AGENT_DIRECTEUR");

// Clients
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const notion = new NotionClient({ auth: NOTION_TOKEN });

// ---- PROMPT SYSTEME (bras droit + doctrine + pipeline interne) ----
const SYSTEM = `
Tu es le Bras Droit IA d'InnovaCSE.
Tu travailles comme une équipe interne : CHEF -> ARCHITECTE -> PRODUCTION.

DOCTRINE (OBLIGATOIRE)
1) InnovaCSE = expert méthodologique CSE. La formation est un vecteur. La méthode est le cœur. Pas de contenu juridique encyclopédique.
2) Promesse : savoir quoi faire, comment, quand, et limites de rôle. Objectif : action structurée.
3) Posture : concret, applicable, structuré, actionnable. Interdits : théorie longue, abstrait, académique, digressions juridiques inutiles.
4) Lignes rouges : jamais conseil disciplinaire, sanction, décision à la place d’un acteur, qualification juridique engageante, remplacement employeur, recommandations RH orga.
Formulations autorisées : “Le cadre légal prévoit…”, “Le CSE peut…”, “La décision relève de…”. Jamais : “Vous devez…”.
5) Structure pédagogique obligatoire : (1) Cadre juridique (2) Analyse structurée (3) Outils mobilisables. Ordre immuable.
6) Logique : transformer en questions structurantes (premier signalement, qui, quand, limites, analyser sans qualifier).
7) Public : élus CSE/SSCT (ou décideurs visés par la demande). Sortie : savoir intervenir, structurer, limites.
8) Style : phrases courtes. Idées claires. Zéro flou. Pas d’empathie excessive. Pas académique.
9) Format livrable : objectifs mesurables, séquences, méthodes, évaluations, durée, positionnement.
10) Discipline : clarifier avant produire. Imposer un choix unique si flou. Refuser dispersion. Pas d’optimisation après validation.

PROCESSUS INTERNE
Étape 1 CHEF : clarifier + produire BRIEF_VALIDÉ.
Étape 2 ARCHITECTE : produire STRUCTURE_QUALIOPI.
Étape 3 PRODUCTION : produire LIVRABLE_FINAL.

SORTIE
Réponds UNIQUEMENT en JSON avec les clés :
- brief_valide (string)
- structure_qualiopi (string)
- livrable_final (string)
Aucun texte hors JSON.
`;

// ---- ROUTES ----
app.get("/", (req, res) => res.status(200).send("OK"));

app.post("/run", async (req, res) => {
  try {
    const { demande_client, contexte, contraintes } = req.body || {};

    const userInput =
`DEMANDE CLIENT:
${demande_client || ""}

CONTEXTE:
${contexte || ""}

CONTRAINTES:
${contraintes || ""}`.trim();

    // Appel OpenAI (1 seul appel)
    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: [
        { role: "system", content: SYSTEM },
        { role: "user", content: userInput }
      ]
    });

    // Récupérer le texte final
    const out = response.output_text?.trim() || "";
    let data;
    try {
      data = JSON.parse(out);
    } catch {
      // si le modèle n'a pas renvoyé du JSON strict (rare), on encapsule
      data = {
        brief_valide: out,
        structure_qualiopi: "",
        livrable_final: ""
      };
    }

    // Ecriture Notion : JOURNAL_AGENT_DIRECTEUR
    const now = new Date().toISOString();

    await notion.pages.create({
      parent: { database_id: DB_JOURNAL },
      properties: {
        // IMPORTANT: le nom de la colonne "Nom" / "Sujet" est le Title de ta DB.
        // Si ta colonne titre s'appelle "Nom", Notion l’appelle "Nom" ici.
        // Si elle s'appelle autrement (ex: "Sujet"), renomme ci-dessous.
        "Nom": { title: [{ text: { content: (demande_client || "Run IA").slice(0, 90) } }] },
        "Date": { date: { start: now } },
        "Décision prise": { rich_text: [{ text: { content: "Run pipeline (Chef→Architecte→Production)" } }] },
        "Agents mobilisés": { multi_select: [{ name: "Directeur" }, { name: "Formation" }] },
        "Résultat produit": { rich_text: [{ text: { content: (data.livrable_final || "").slice(0, 2000) } }] },
        "Prochaine action": { rich_text: [{ text: { content: "Valider / ajuster puis lancer un cas réel suivant." } }] }
      }
    });

    return res.json({ ok: true, data });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: String(err?.message || err)
    });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on ${port}`));
