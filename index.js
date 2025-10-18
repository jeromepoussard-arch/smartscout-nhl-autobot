import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// ---------- CONFIG ----------
const NHL_HOOK = process.env.DISCORD_WEBHOOK_NHL;
const FIRST_WINDOW_MIN = 90;
const LOOKAHEAD_HOURS = 6;
const SCHED_HOURS = { start: 16, end: 23 };

// ---------- OUTILS TEMPS ----------
function nowParis() { return new Date(); }
function toParisString(d) { return d.toLocaleString("fr-FR", { timeZone: "Europe/Paris" }); }
function diffMin(a,b){return Math.round((a.getTime()-b.getTime())/60000);}

// ---------- FETCH NHL ----------
async function fetchNhlSchedule(dateStr){
  const url = `https://api.nhle.com/stats/rest/en/schedule?cayenneExp=gameDate%3E=%22${dateStr}%22%20and%20gameDate%3C=%22${dateStr}%22`;
  const res = await fetch(url);
  if(!res.ok) throw new Error(`NHL schedule HTTP ${res.status}`);
  const json = await res.json();
  const games = json?.data || [];
  return games.map(g=>({
    id:g.gameId,
    away:g.awayTeamAbbrev,
    home:g.homeTeamAbbrev,
    startUTC:g.gameDate,
    startDate:new Date(g.gameDate),
    state:"FUT"
  }));
}

async function getScheduleParisDay(dateObj){
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth()+1).padStart(2,"0");
  const d = String(dateObj.getDate()).padStart(2,"0");
  return await fetchNhlSchedule(`${y}-${m}-${d}`);
}

// ---------- DISCORD ----------
async function postToDiscord(payload){
  const res = await fetch(NHL_HOOK,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
  if(!res.ok) throw new Error(`Discord ${res.status}`);
}

// ---------- LOGIQUE ----------
function windowAndGames(games,now){
  if(!games.length)return{ok:false,reason:"no games"};
  const sorted=games.sort((a,b)=>a.startDate-b.startDate);
  const first=sorted[0];
  const minToFirst=diffMin(first.startDate,now);
  const windowOk=minToFirst<=FIRST_WINDOW_MIN;
  const within=sorted.filter(g=>diffMin(g.startDate,now)<=LOOKAHEAD_HOURS*60);
  return{ok:true,windowOk,minToFirst,first,within};
}

function buildPrematchMessage(within){
  const header="[DISCORD:NHL] 🏒 Pré-match NHL (auto)\n";
  const lines=within.map(g=>`• ${g.away} @ ${g.home} — ${toParisString(g.startDate)} (Paris)`);
  return header+lines.join("\n");
}

async function generatePrematchDiscord(){
  try{
    const now=nowParis();
    const games=await getScheduleParisDay(now);
    const diag=windowAndGames(games,now);
    if(!diag.ok||!diag.windowOk)return{ok:true,sent:false,reason:diag.reason||"no window",diag};
    const msg=buildPrematchMessage(diag.within);
    await postToDiscord({content:msg});
    return{ok:true,sent:true,diag};
  }catch(e){return{ok:false,error:e.message};}
}

// ---------- ROUTES ----------
app.get("/ping",(_req,res)=>res.send("pong"));
app.get("/prematch/why",async(_req,res)=>res.json(await generatePrematchDiscord()));
app.get("/prematch/force",async(_req,res)=>res.json(await generatePrematchDiscord()));
app.get("/cron/manual",async(_req,res)=>res.json(await generatePrematchDiscord()));

setInterval(()=>generatePrematchDiscord(),60*1000);

const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log(`SmartScout NHL autobot running on ${PORT}`));