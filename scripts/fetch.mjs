// Henter Squad92's seneste kampe fra PUBG API og gemmer de godkendte i data/matches.json.
// Kør: PUBG_API_KEY=xxx node scripts/fetch.mjs
//
// En kamp gemmes, hvis mindst ét hold i kampen KUN består af clan-medlemmer
// (og mindst `minClanMembersInTeam` af dem), og spiltype/kamptype er tilladt i config.json.

import fs from 'node:fs/promises';

const root = new URL('..', import.meta.url);
const configPath = new URL('config.json', root);
const dataPath = new URL('data/matches.json', root);

const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
const KEY = process.env.PUBG_API_KEY;
if (!KEY) {
  console.error('Mangler PUBG_API_KEY (miljøvariabel).');
  process.exit(1);
}

const BASE = `https://api.pubg.com/shards/${config.platform}`;
const HEADERS = { Authorization: `Bearer ${KEY}`, Accept: 'application/vnd.api+json' };
const CHECKED_TTL_DAYS = 30; // PUBG gemmer kampe i 14 dage; vi husker tjekkede ID'er lidt længere

async function api(path, { auth = true } = {}) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(BASE + path, { headers: auth ? HEADERS : { Accept: HEADERS.Accept } });
    if (res.ok) return res.json();
    if (res.status === 404) return null;
    if (res.status === 429) {
      const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
      const wait = reset ? Math.max(reset - Date.now(), 1000) : 60_000;
      console.warn(`Rate limit ramt, venter ${Math.round(wait / 1000)}s ...`);
      await new Promise((r) => setTimeout(r, Math.min(wait, 65_000)));
      continue;
    }
    if (res.status >= 500 && attempt < 4) {
      await new Promise((r) => setTimeout(r, attempt * 2000));
      continue;
    }
    throw new Error(`PUBG API ${res.status} på ${path}: ${await res.text()}`);
  }
  throw new Error(`Gav op efter flere forsøg: ${path}`);
}

async function loadData() {
  try {
    return JSON.parse(await fs.readFile(dataPath, 'utf8'));
  } catch {
    return { updatedAt: null, members: [], matches: [], checked: {} };
  }
}

// --- 1. Find spillerne (ét kald for alle navne; op til 10 pr. kald) ---
async function fetchPlayers(names) {
  const q = encodeURIComponent(names.join(','));
  let json = await api(`/players?filter[playerNames]=${q}`);
  let players = json?.data ?? [];
  // Hvis et navn ikke findes, kan hele kaldet fejle: prøv så hvert navn for sig.
  if (players.length < names.length) {
    const found = new Set(players.map((p) => p.attributes.name.toLowerCase()));
    for (const name of names.filter((n) => !found.has(n.toLowerCase()))) {
      const one = await api(`/players?filter[playerNames]=${encodeURIComponent(name)}`);
      if (one?.data?.length) players.push(...one.data);
      else console.warn(`Spilleren "${name}" blev ikke fundet på ${config.platform}.`);
    }
  }
  return players;
}

// --- 2. Analyser én kamp ---
function analyseMatch(json, memberIds, memberNames) {
  const a = json.data.attributes;
  if (!config.gameModes.includes(a.gameMode)) return null;
  if (!config.matchTypes.includes(a.matchType)) return null;

  const participants = new Map();
  const rosters = [];
  for (const inc of json.included ?? []) {
    if (inc.type === 'participant') participants.set(inc.id, inc.attributes.stats);
    else if (inc.type === 'roster') rosters.push(inc);
  }

  const isMember = (s) => memberIds.has(s.playerId) || memberNames.has(String(s.name).toLowerCase());

  const teams = [];
  for (const r of rosters) {
    const stats = r.relationships.participants.data.map((p) => participants.get(p.id)).filter(Boolean);
    const members = stats.filter(isMember);
    if (members.length < config.minClanMembersInTeam) continue;
    if (members.length !== stats.length) continue; // nogen udefra på holdet -> tæller ikke
    teams.push({
      rank: r.attributes.stats.rank,
      won: r.attributes.won === 'true' || r.attributes.won === true,
      players: members.map((s) => ({
        name: s.name,
        accountId: s.playerId,
        damage: Math.round(s.damageDealt * 10) / 10,
        kills: s.kills,
        assists: s.assists,
        dbnos: s.DBNOs,
        headshots: s.headshotKills,
        revives: s.revives,
        timeSurvived: Math.round(s.timeSurvived),
        longestKill: Math.round(s.longestKill * 10) / 10,
        deathType: s.deathType,
        winPlace: s.winPlace,
      })),
    });
  }
  if (!teams.length) return null;
  return {
    id: json.data.id,
    createdAt: a.createdAt,
    map: a.mapName,
    gameMode: a.gameMode,
    matchType: a.matchType,
    duration: a.duration,
    teams,
  };
}

// --- Main ---
const data = await loadData();
data.checked ??= {};
const known = new Set(data.matches.map((m) => m.id));

const players = await fetchPlayers(config.members);
data.members = players.map((p) => ({ name: p.attributes.name, accountId: p.id }));
const memberIds = new Set(players.map((p) => p.id));
const memberNames = new Set(config.members.map((n) => n.toLowerCase()));

const matchIds = new Set();
for (const p of players) for (const m of p.relationships?.matches?.data ?? []) matchIds.add(m.id);
const todo = [...matchIds].filter((id) => !known.has(id) && !data.checked[id]);
console.log(`${players.length} spillere, ${matchIds.size} kampe i alt, ${todo.length} nye at tjekke.`);

// /matches tæller ikke med i rate limit og kræver ikke nøgle
let added = 0;
const queue = [...todo];
async function worker() {
  while (queue.length) {
    const id = queue.shift();
    const json = await api(`/matches/${id}`, { auth: false });
    if (!json) continue;
    data.checked[id] = json.data.attributes.createdAt;
    const match = analyseMatch(json, memberIds, memberNames);
    if (match) {
      data.matches.push(match);
      added++;
    }
  }
}
await Promise.all(Array.from({ length: 5 }, worker));

// Ryd gamle tjek-ID'er op (kampene selv beholdes som historik)
const cutoff = Date.now() - CHECKED_TTL_DAYS * 864e5;
for (const [id, at] of Object.entries(data.checked)) if (Date.parse(at) < cutoff) delete data.checked[id];

data.matches.sort((x, y) => Date.parse(y.createdAt) - Date.parse(x.createdAt));
// Skriv kun filen, hvis noget har ændret sig (så workflowet ikke committer hver time for ingenting)
const before = JSON.stringify({ ...(await loadData()), updatedAt: null });
if (JSON.stringify({ ...data, updatedAt: null }) !== before) {
  data.updatedAt = new Date().toISOString();
  await fs.writeFile(dataPath, JSON.stringify(data, null, 1) + '\n');
}
console.log(`Færdig: ${added} nye godkendte kampe, ${data.matches.length} gemt i alt.`);
