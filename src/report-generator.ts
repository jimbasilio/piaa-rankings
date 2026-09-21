#!/usr/bin/env node
/** Build a verified daily PIAA District 1 PAC boys-soccer report. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as cheerio from "cheerio";

const execFileAsync = promisify(execFile);
const BASE_DIR = "/home/jim/projects/piaa-rankings";
const DATA_DIR = `${BASE_DIR}/data/pac-soccer`;
const FILES = {
  previous: `${DATA_DIR}/previous-standings.json`, current: `${DATA_DIR}/current-standings.json`,
  games: `${DATA_DIR}/current-games.json`, summary: `${DATA_DIR}/last-game-summary.json`,
  roundup: `${DATA_DIR}/pv-roundup-notices.json`, newsletter: `${DATA_DIR}/athletic-newsletter-state.json`,
};
const STANDINGS_URL = "https://www.piaad1.org/sports/fall-sports/soccer-b/scores-and-rankings/";
const ROUNDUP_INDEX_URL = "https://www.pottsmerc.com/sports/high-school-sports/";
const YOUTUBE_SEARCH_URL = "https://www.googleapis.com/youtube/v3/search";
const HEADERS = { "User-Agent": "PAC-Soccer-Daily-Report/1.0 (+local cron job)" };

const PAC_DIVISIONS: Record<string, string[]> = {
  "Liberty Division": ["Boyertown", "Methacton", "Norristown", "Owen J. Roberts", "Perkiomen Valley", "Spring-Ford"],
  "Frontier Division": ["Phoenixville", "Pope John Paul II", "Pottsgrove", "Pottstown", "Upper Merion", "Upper Perkiomen"],
};
const TEAM_URLS: Record<string, string> = Object.fromEntries([
  "Phoenixville", "Perkiomen Valley", "Upper Perkiomen", "Spring-Ford", "Owen J. Roberts", "Boyertown", "Methacton", "Norristown", "Pope John Paul II", "Pottsgrove", "Pottstown", "Upper Merion",
].map((team) => [team, `https://www.piaad1.org/sports/fall-sports/soccer-b/scores-and-rankings/games/2026-${team.toLowerCase().replaceAll(".", "").replaceAll(" ", "-")}-boys-soccer`]));
TEAM_URLS["Owen J. Roberts"] = "https://www.piaad1.org/sports/fall-sports/soccer-b/scores-and-rankings/games/2026-owen-j-roberts-boys-soccer";
TEAM_URLS["Pope John Paul II"] = "https://www.piaad1.org/sports/fall-sports/soccer-b/scores-and-rankings/games/2026-pope-john-paul-ii-boys-soccer";
const NAME_MAP: Record<string, string> = {
  "BOYERTOWN": "Boyertown", "METHACTON": "Methacton", "NORRISTOWN": "Norristown", "OWEN J. ROBERTS": "Owen J. Roberts", "PERKIOMEN VALLEY": "Perkiomen Valley", "SPRING-FORD": "Spring-Ford", "PHOENIXVILLE": "Phoenixville", "POPE JOHN PAUL II": "Pope John Paul II", "POTTSGROVE": "Pottsgrove", "POTTSTOWN": "Pottstown", "UPPER MERION": "Upper Merion", "UPPER PERKIOMEN": "Upper Perkiomen",
};
const ALL_TEAMS = Object.values(NAME_MAP);

type Standing = { team: string; classification: string; seed: number; wins: number; losses: number; ties: number };
type Game = { date: string; opponent: string; team_score: number; opponent_score: number; outcome: "win" | "loss" | "tie"; note: string | null };
type GameResponse = { team: string; source_url: string; retrieved_at: string; game: Game | null; error: string | null };
type Newsletter = { message_id: string; date: string; notes: string[] };
type Roundup = { game_key: string; url: string; game: Pick<Game, "date" | "opponent" | "team_score" | "opponent_score">; recap: string };

function clean(value: string): string { return value.replace(/\s+/g, " ").trim(); }
function nowIso(): string { return new Date().toLocaleString("sv-SE", { timeZone: "America/New_York" }).replace(" ", "T") + "-04:00"; }
function todayIso(): string { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
function dateDisplay(date: string): string { return new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`)); }
async function writeJson(path: string, value: unknown): Promise<void> { await mkdir(DATA_DIR, { recursive: true }); await writeFile(path, JSON.stringify(value), "utf8"); }
async function readJson<T>(path: string, fallback: T): Promise<T> { try { return JSON.parse(await readFile(path, "utf8")) as T; } catch { return fallback; } }
async function fetchText(url: string): Promise<[string | null, string | null]> { try { const response = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(30_000) }); if (!response.ok) throw new Error(); return [await response.text(), null]; } catch { return [null, "HTTP request failed"]; } }
function int(value: string | undefined): number | null { return value && /^\d+$/.test(value.trim()) ? Number(value) : null; }

async function getStandings(): Promise<{ source_url: string; retrieved_at: string; teams: Standing[]; missing_teams: string[]; error: string | null }> {
  const retrieved_at = nowIso(), [html, failure] = await fetchText(STANDINGS_URL);
  if (!html) return { source_url: STANDINGS_URL, retrieved_at, teams: [], missing_teams: ALL_TEAMS, error: failure };
  const $ = cheerio.load(html), found = new Map<string, Standing>(), invalid: string[] = []; let division: string | null = null;
  $("h1,h2,h3,h4,table").each((_, element) => {
    if (/^h[1-4]$/i.test(element.tagName)) { division = clean($(element).text()).match(/\b([1-4]A)\b/i)?.[1].toUpperCase() ?? null; return; }
    const table = element, divisionName = division; if (!divisionName) return;
    $(table).find("tbody tr").each((_, row) => {
      const team = NAME_MAP[clean($(row).find('[data-field="schoolName"]').text()).toUpperCase()]; if (!team) return;
      const cells = $(row).find("td"); const seed = int(cells.eq(0).text());
      const wins = int($(row).find('[data-field="wins"]').text()), losses = int($(row).find('[data-field="losses"]').text()), ties = int($(row).find('[data-field="ties"]').text());
      if (seed === null || wins === null || losses === null || ties === null || found.has(team)) { invalid.push(team); return; }
      found.set(team, { team, classification: divisionName, seed, wins, losses, ties });
    });
  });
  const teams = [...found.values()], missing_teams = ALL_TEAMS.filter((team) => !found.has(team));
  return { source_url: STANDINGS_URL, retrieved_at, teams, missing_teams, error: missing_teams.length || invalid.length ? "Standings extraction incomplete" : null };
}

function parseGameRows(team: string, html: string): Game[] {
  const target = Object.entries(NAME_MAP).find(([, value]) => value === team)?.[0]!, $ = cheerio.load(html), games: Game[] = [];
  $("table tbody tr").each((_, row) => {
    const cells = $(row).find("td"); if (cells.length < 4) return;
    const rawDate = clean(cells.eq(0).text()); const matchedDate = rawDate.match(/^(\d{2})\/(\d{2})\/(\d{4})$/); if (!matchedDate) return;
    const date = `${matchedDate[3]}-${matchedDate[1]}-${matchedDate[2]}`; const home = clean(cells.eq(1).text()), visitor = clean(cells.eq(2).text()); const score = clean(cells.eq(3).text()).match(/^(\d+)\s*\/\s*(\d+)$/);
    if (!score || date > todayIso()) return;
    let team_score: number, opponent_score: number, opponent: string;
    if (home.toUpperCase() === target) { team_score = Number(score[1]); opponent_score = Number(score[2]); opponent = visitor; }
    else if (visitor.toUpperCase() === target) { team_score = Number(score[2]); opponent_score = Number(score[1]); opponent = home; } else return;
    games.push({ date, opponent, team_score, opponent_score, outcome: team_score > opponent_score ? "win" : team_score < opponent_score ? "loss" : "tie", note: null });
  }); return games;
}
async function getGameHistory(team: string): Promise<GameResponse> {
  const source_url = TEAM_URLS[team], retrieved_at = nowIso(), [html, error] = await fetchText(source_url); if (!html) return { team, source_url, retrieved_at, game: null, error };
  const games = parseGameRows(team, html); if (!games.length) return { team, source_url, retrieved_at, game: null, error: null };
  const latest = games.map((game) => game.date).sort().at(-1)!; const candidates = games.filter((game) => game.date === latest); const game = candidates.at(-1)!;
  if (candidates.length > 1) game.note = "Multiple completed games shared the latest date; used the last displayed game.";
  return { team, source_url, retrieved_at, game, error: null };
}
function normalized(value: string): string { return clean(value).toUpperCase().replace("PERK VALLEY", "PERKIOMEN VALLEY").replace(/[^A-Z0-9]/g, ""); }
async function getAllGames(team: string): Promise<Game[]> { const [html] = await fetchText(TEAM_URLS[team]); return html ? parseGameRows(team, html) : []; }
async function roundupCandidates(): Promise<string[]> { const found = new Set<string>(); for (let page = 1; page <= 3; page += 1) { const [html] = await fetchText(page === 1 ? ROUNDUP_INDEX_URL : `${ROUNDUP_INDEX_URL}page/${page}/`); if (!html) continue; const $ = cheerio.load(html); $("a[href]").each((_, link) => { const href = $(link).attr("href") ?? "", title = clean($(link).text()); if (/^https:\/\/www\.pottsmerc\.com\/\d{4}\/\d{2}\/\d{2}\//.test(href) && /roundup|soccer/i.test(title)) found.add(href); }); } return [...found].slice(0, 40); }
function boysSoccerParagraphs(html: string): string[] { const $ = cheerio.load(html), paragraphs = $(".article-content-wrapper p").toArray(); const start = paragraphs.findIndex((paragraph) => clean($(paragraph).text()).toLowerCase() === "boys soccer"); if (start < 0) return []; const output: string[] = []; for (const paragraph of paragraphs.slice(start + 1)) { const text = clean($(paragraph).text()); if ($(paragraph).find("em").length && text) break; if (text) output.push(text); } return output; }
async function roundup(): Promise<Roundup | null> { const games = await getAllGames("Perkiomen Valley"), latest = games.map((game) => game.date).sort().at(-1); const ledger = await readJson<{ delivered?: { game_key?: string }[] }>(FILES.roundup, {}), delivered = new Set((ledger.delivered ?? []).map((item) => item.game_key)); if (!latest) return null; for (const url of await roundupCandidates()) { const [html] = await fetchText(url); if (!html) continue; const paragraphs = boysSoccerParagraphs(html); for (const [index, line] of paragraphs.entries()) { const match = line.match(/^(.+?)\s+(\d+),\s*(.+?)\s+(\d+)$/); if (!match) continue; const [, left, leftScore, right, rightScore] = match; let opponent: string, teamScore: number, opponentScore: number; if (normalized(left) === normalized("Perkiomen Valley")) { opponent = clean(right); teamScore = Number(leftScore); opponentScore = Number(rightScore); } else if (normalized(right) === normalized("Perkiomen Valley")) { opponent = clean(left); teamScore = Number(rightScore); opponentScore = Number(leftScore); } else continue; const game = games.find((item) => normalized(item.opponent) === normalized(opponent) && item.team_score === teamScore && item.opponent_score === opponentScore); if (!game || game.date !== latest) continue; const game_key = `${game.date}|${normalized(game.opponent)}|${teamScore}|${opponentScore}`; if (!delivered.has(game_key)) return { game_key, url, game, recap: paragraphs[index + 1] ?? "" }; } } return null; }

async function loadEnv(): Promise<void> { try { for (const line of (await readFile(`${BASE_DIR}/.env`, "utf8")).split("\n")) { if (line.startsWith("YOUTUBE_API_KEY=") && !process.env.YOUTUBE_API_KEY) process.env.YOUTUBE_API_KEY = line.slice(16).trim().replace(/^['"]|['"]$/g, ""); } } catch {} }
async function videos(): Promise<{ title: string; url: string }[]> { const key = process.env.YOUTUBE_API_KEY; if (!key) return []; const out: { title: string; url: string }[] = [];
  for (const [q, maxResults] of [["soccer winger positioning tutorial", 2], ["soccer midfielder positioning tutorial", 1]] as const) try { const url = new URL(YOUTUBE_SEARCH_URL); Object.entries({ key, part: "snippet", type: "video", maxResults: String(maxResults), q, safeSearch: "strict", videoEmbeddable: "true" }).forEach(([k, v]) => url.searchParams.set(k, v)); const body = await (await fetch(url, { signal: AbortSignal.timeout(20_000) })).json() as { items?: { id?: { videoId?: string }; snippet?: { title?: string } }[] }; for (const item of body.items ?? []) if (item.id?.videoId && item.snippet?.title) out.push({ title: clean(item.snippet.title), url: `https://www.youtube.com/watch?v=${item.id.videoId}` }); } catch { return []; } return out.slice(0, 3); }

function newsletterNotes(body: string): string[] { const lines: string[] = []; let selected = false; for (const raw of body.replaceAll("&nbsp;", " ").split("\n")) { const line = clean(raw.replaceAll("|", " ")); const heading = line.match(/^#{1,6}\s*(.*?)\s*$/)?.[1]; const normalizedHeading = normalized(heading ?? "").toLowerCase(); if (["varsityboyssoccer", "varsitysoccer"].includes(normalizedHeading)) { selected = true; continue; } if (selected && heading) break; if (selected && line && !line.startsWith("<!--")) lines.push(line); } return lines; }
async function newsletter(): Promise<Newsletter | null> { try { const search = JSON.parse((await execFileAsync("gog", ["gmail", "messages", "search", 'subject:"Athletic Newsletter"', "--max", "10", "--json", "--no-input"], { timeout: 45_000 })).stdout) as { messages?: { id: string; from?: string; internalDateIso?: string; date?: string }[] }; for (const item of search.messages ?? []) { if (!/(parentsquare|pvsd\.org)/i.test(item.from ?? "")) continue; const detail = JSON.parse((await execFileAsync("gog", ["gmail", "get", item.id, "--json", "--no-input"], { timeout: 45_000 })).stdout) as { body?: string }; const notes = newsletterNotes(detail.body ?? ""); if (notes.length) return { message_id: item.id, date: item.internalDateIso ?? item.date ?? "", notes }; } } catch {} return null; }
function formatNewsletter(notes: string[]): string[] { const out: string[] = []; let schedule = false; for (const note of notes) { const [label, ...rest] = note.split(":"); const detail = rest.join(":").trim(), normal = label.toLowerCase(); if (detail && normal.startsWith("results from last week")) { out.push("", "🏁 **Last Week’s Results**", detail); schedule = false; } else if (detail && normal.startsWith("unsung athletes of the week")) { out.push("", "🏅 **Unsung Athlete of the Week**", detail); schedule = false; } else if (detail && normal.startsWith("events this week")) { out.push("", "📅 **This Week’s Schedule**", `• ${detail}`); schedule = true; } else if (schedule) out.push(`• ${note}`); else out.push(note); } return out; }

function moves(current: Record<string, Standing>, previous: Record<string, Pick<Standing, "classification" | "seed">>): Record<string, string> { return Object.fromEntries(ALL_TEAMS.map((team) => { const currentTeam = current[team], prior = previous[team]; return [team, !currentTeam ? "❓" : !prior || prior.classification !== currentTeam.classification ? "🆕" : currentTeam.seed < prior.seed ? "📈" : currentTeam.seed > prior.seed ? "📉" : "⚖️"]; })); }
function highlights(current: Record<string, Standing>, previous: Record<string, Pick<Standing, "classification" | "seed">>): string[] { const changes = Object.values(current).flatMap((value) => { const prior = previous[value.team]; const delta = prior?.classification === value.classification ? prior.seed - value.seed : 0; return delta ? [[value.team, delta] as const] : []; }).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]) || a[0].localeCompare(b[0])); if (!changes.length) return []; const chosen = changes.slice(0, 3), pv = changes.find(([team]) => team === "Perkiomen Valley"); if (pv && !chosen.includes(pv)) chosen[chosen.length - 1] = pv; return ["🚨 **Rankings on the Move**", ...chosen.map(([team, delta]) => `${delta > 0 ? "📈" : "📉"} **${team} ${delta > 0 ? "rises" : "falls"} ${Math.abs(delta)} place${Math.abs(delta) === 1 ? "" : "s"}!**`)]; }
function validStandings(value: { error: string | null; teams: Standing[] }): boolean { return !value.error && value.teams.length === 12 && new Set(value.teams.map((team) => team.team)).size === 12; }
function gameSnapshot(games: GameResponse[]): Record<string, Game | null> { return Object.fromEntries(games.map((item) => [item.team, item.game])); }
function sameJson(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function gameLine(team: string, standing: Standing, response: GameResponse): string { if (response.error) return `**${team}:** ❓ Most recent result unavailable; source could not be verified.`; if (!response.game) return `**${team}:** ✨ No completed games recorded.`; const game = response.game, symbol = game.outcome === "win" ? "✅" : game.outcome === "loss" ? "❌" : "🤝"; return `**${team} (${standing.classification}):** ${dateDisplay(game.date)} — ${game.team_score}–${game.opponent_score} vs. ${game.opponent} ${symbol}`; }

function report(standings: Awaited<ReturnType<typeof getStandings>>, games: GameResponse[], previous: Record<string, Pick<Standing, "classification" | "seed">>, newGames: boolean, roundupValue: Roundup | null, newsletterValue: Newsletter | null, quiet: boolean, videoList: { title: string; url: string }[]): string {
  const current = Object.fromEntries(standings.teams.map((team) => [team.team, team])), move = moves(current, previous), pv = current["Perkiomen Valley"], now = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "America/New_York" }).format(new Date());
  const lines = ["⚽ **Perkiomen Valley Soccer Daily Update!** ⚽", `📅 **${now}**`, "", "💙 **PV Check-In**"];
  if (quiet) { lines.push("📣 **No new PAC updates today—but the soccer focus stays strong!**", "The standings are unchanged, no new completed PAC games were recorded, and there’s no new Mercury PV recap to share. Team Together! ⚽"); if (videoList.length) lines.push("", "🎥 **Mickey’s Positioning Corner**", "No fresh scoreboard news means it’s a great day to sharpen the soccer IQ. Here are three optional positioning videos:", "", ...videoList.map((video, index) => `**${index + 1}.** [${video.title}](${video.url})`)); return lines.join("\n"); }
  if (pv) lines.push(`Rank: **#${pv.seed}/${pv.classification}** ${move[pv.team]}`, `Record: **${pv.wins}-${pv.losses}-${pv.ties}**`, "", newGames ? "PV is on the move with a verified result in its latest action! 💪" : "No new completed PAC games have been recorded since the last full game summary, so this update is all about the standings. 🛡️");
  const rankingHighlights = highlights(current, previous); if (rankingHighlights.length) lines.push("", ...rankingHighlights);
  if (roundupValue) { const game = roundupValue.game, result = game.team_score > game.opponent_score ? "win" : game.team_score < game.opponent_score ? "loss" : "tie"; lines.push("", "📰 **PV Roundup Spotlight**", `The Mercury’s Boys Soccer roundup checked in on PV’s ${dateDisplay(game.date)} ${result}: **${game.team_score}–${game.opponent_score} vs. ${game.opponent}**.`); if (roundupValue.recap) lines.push("", roundupValue.recap); lines.push("", `⚽ Want more PAC scores and local high-school action? [Catch the full Mercury roundup](${roundupValue.url})!`); }
  if (newsletterValue) lines.push("", "📬 **From the Athletic Director’s Newsletter**", ...formatNewsletter(newsletterValue.notes));
  lines.push("", "🔥 **Today’s PAC Pulse**", rankingHighlights.length ? "The PAC board has fresh movement to watch—every Seed change above is verified from today’s standings." : "12 PAC sides held their position.", "", "🛡️ **PAC Division Watch**", "");
  for (const [division, teams] of Object.entries(PAC_DIVISIONS)) { lines.push(`**${division}**`, ""); const groups = division === "Frontier Division" ? [["4A", teams.filter((team) => current[team]?.classification === "4A")], ["3A", teams.filter((team) => current[team]?.classification === "3A")]] : [["", teams]]; for (const [name, group] of groups) { if (name) lines.push(`*${name} Rankings*`, ""); for (const team of [...group].sort((a, b) => current[a].seed - current[b].seed || a.localeCompare(b))) { const item = current[team]; lines.push(`**${team}: #${item.seed}/${item.classification} ${move[team]}** — ${item.wins}-${item.losses}-${item.ties}`); } lines.push(""); } }
  if (newGames) { lines.push("⚽ **Latest Action Around the PAC**", "Here’s how each team finished in its most recent completed match:", ""); const byTeam = Object.fromEntries(games.map((game) => [game.team, game])); for (const [division, teams] of Object.entries(PAC_DIVISIONS)) { lines.push(`**${division}**`, "", ...teams.map((team) => gameLine(team, current[team], byTeam[team])), ""); } } else lines.push("📌 **Standings-Only Update**", "No new completed PAC games have been recorded since the last full game summary. The rankings above are today’s full verified update."); return lines.join("\n").trim();
}

async function main(): Promise<void> {
  await loadEnv(); const priorCurrent = await readJson<{ teams?: Standing[] }>(FILES.current, {}), priorMap = priorCurrent.teams?.length === 12 ? Object.fromEntries(priorCurrent.teams.map((team) => [team.team, team])) : null;
  const standings = await getStandings(); await writeJson(FILES.current, standings); const previous = (await readJson<{ teams?: Record<string, Pick<Standing, "classification" | "seed">> }>(FILES.previous, {})).teams ?? {};
  const games = await Promise.all(ALL_TEAMS.map(getGameHistory)); await writeJson(FILES.games, games); const last = await readJson<{ games?: Record<string, Game | null> }>(FILES.summary, {}); const newGames = games.some((game) => game.error) || !last.games || !sameJson(gameSnapshot(games), last.games);
  const roundupValue = await roundup();
  const newsletterValue = await newsletter(), newsletterState = await readJson<{ message_id?: string }>(FILES.newsletter, {}), newsletterNew = !!newsletterValue && newsletterValue.message_id !== newsletterState.message_id;
  const currentMap = Object.fromEntries(standings.teams.map((item) => [item.team, item]));
  const standingFields: (keyof Standing)[] = ["classification", "seed", "wins", "losses", "ties"];
  const standingChanged = !priorMap || ALL_TEAMS.some((team) => standingFields.some((field) => currentValue(priorMap[team], field) !== currentValue(currentMap[team], field)));
  const quiet = validStandings(standings) && games.every((game) => !game.error) && !standingChanged && !newGames && !roundupValue && !newsletterNew; console.log(report(standings, games, previous, newGames, roundupValue, newsletterNew ? newsletterValue : null, quiet, quiet ? await videos() : []));
  if (newGames && games.every((game) => !game.error)) await writeJson(FILES.summary, { summary_date: todayIso(), games: gameSnapshot(games) });
  if (validStandings(standings)) await writeJson(FILES.previous, { snapshot_date: todayIso(), source_url: STANDINGS_URL, teams: Object.fromEntries(standings.teams.map((team) => [team.team, { classification: team.classification, seed: team.seed }])) });
  if (newsletterValue) await writeJson(FILES.newsletter, { message_id: newsletterValue.message_id, retrieved_at: nowIso() });
  if (roundupValue) { const ledger = await readJson<{ delivered?: unknown[] }>(FILES.roundup, {}); await writeJson(FILES.roundup, { delivered: [...(ledger.delivered ?? []), { game_key: roundupValue.game_key, article_url: roundupValue.url, delivered_at: nowIso() }] }); }
}
function currentValue(value: Standing | undefined, field: keyof Standing): unknown { return value?.[field]; }
main().catch((error: unknown) => { console.error(error instanceof Error ? error.stack : error); process.exitCode = 1; });
