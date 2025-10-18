import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// URL du webhook Discord (injection Render)
const NHL_HOOK = process.env.DISCORD_WEBHOOK_NHL;

// Fonction pour publier sur Discord
async function postToDiscord(payload) {
  try {
    const res = await fetch(NHL_HOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`Discord: ${res.status}`);
  } catch (err) {
    console.error("Erreur Discord:", err.message);
  }
}

// Route test manuelle
app.get("/test/prematch", async (_req, res) => {
  await postToDiscord({
    content: `[DISCORD:NHL] 🔵 SmartScout — Simulation pré-match NHL TEST\nMatch test : Maple Leafs @ Canadiens\nHeure : 01h00 (Europe/Paris)\nAnalyse : Toronto domine en xG et PP, Montréal peine en PK.\nTendance : Victoire Leafs 🔹 Over 6.5 🔹 Matthews buteur.\nConfiance globale SmartScout : 81/100`
  });
  res.send("Pré-match envoyé sur Discord ✅");
});

app.get("/ping", (_req, res) => res.send("pong"));

// Fonction horodatage Paris
function nowParis() {
  return new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris" });
}

// Scheduler principal
function scheduler() {
  const d = new Date();
  const heure = d.getUTCHours() + 2; // UTC + 2 = heure de Paris
  const minutes = d.getMinutes();

  // Exécution à 08h00 (récap) et chaque heure de 16h à 23h (pré-match)
  if (minutes === 0 && ((heure >= 16 && heure <= 23) || heure === 8)) {
    const type = heure === 8 ? "récap" : "pré-match";
    console.log(`[${nowParis()}] Lancement ${type.toUpperCase()}`);

    const msg = type === "pré-match"
      ? `[DISCORD:NHL] 📊 SmartScout — Pré-match NHL (T-90)\nAnalyse complète générée automatiquement.`
      : `[DISCORD:NHL] 📈 SmartScout — Récap NHL du jour\nSynthèse des matchs précédents.`;

    postToDiscord({ content: msg });
  }
}

// Boucle minute
setInterval(scheduler, 60 * 1000);

app.listen(3000, () => console.log("SmartScout NHL autobot up on 3000"));
