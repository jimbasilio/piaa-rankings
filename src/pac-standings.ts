#!/usr/bin/env node
/**
 * Calculate unofficial PAC boys-soccer standings from completed PIAA games.
 * Mercury Boys Soccer roundups are used only to cross-check reported records.
 */
import * as cheerio from "cheerio";

const PIAA_BASE = "https://www.piaad1.org/sports/fall-sports/soccer-b/scores-and-rankings/games";
const MERCURY_INDEX = "https://www.pottsmerc.com/sports/high-school-sports/";
const HEADERS = { "User-Agent": "PAC-Soccer-Standings/1.0 (+local cron job)" };

const PAC_TEAMS = [
  "Boyertown", "Methacton", "Norristown", "Owen J. Roberts", "Perkiomen Valley", "Spring-Ford",
  "Phoenixville", "Pope John Paul II", "Pottsgrove", "Pottstown", "Upper Merion", "Upper Perkiomen",
] as const;

type Team = (typeof PAC_TEAMS)[number];

const DIVISIONS: Record<string, readonly Team[]> = {
  Liberty: ["Boyertown", "Methacton", "Norristown", "Owen J. Roberts", "Perkiomen Valley", "Spring-Ford"],
  Frontier: ["Phoenixville", "Pope John Paul II", "Pottsgrove", "Pottstown", "Upper Merion", "Upper Perkiomen"],
};
const TEAM_TO_DIVISION = new Map(PAC_TEAMS.map((team) => [team, Object.entries(DIVISIONS).find(([, teams]) => teams.includes(team))?.[0]! ]));
const TEAM_ALIASES: Record<Team, string[]> = {
  "Boyertown": ["Boyertown", "Bears"],
  "Methacton": ["Methacton", "Warriors"],
  "Norristown": ["Norristown", "Eagles"],
  "Owen J. Roberts": ["Owen J. Roberts", "OJR", "Wildcats"],
  "Perkiomen Valley": ["Perkiomen Valley", "Perk Valley", "PV", "Vikings"],
  "Spring-Ford": ["Spring-Ford", "Rams"],
  "Phoenixville": ["Phoenixville", "Phantoms"],
  "Pope John Paul II": ["Pope John Paul II", "PJP", "Golden Panthers"],
  "Pottsgrove": ["Pottsgrove", "Falcons"],
  "Pottstown": ["Pottstown", "Trojans"],
  "Upper Merion": ["Upper Merion", "UM", "Vikings"],
  "Upper Perkiomen": ["Upper Perkiomen", "Indians"],
};

type WltRecord = { wins: number; losses: number; ties: number };
type Game = { date: string; opponent: string; teamScore: number; opponentScore: number };
type TeamSummary = { team: Team; division: string; overall: WltRecord; pac: WltRecord; divisionRecord: WltRecord; points: number };
type MercurySnapshot = { overall: WltRecord; pac: WltRecord; articleUrl: string };

function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalized(value: string): string {
  return clean(value)
    .toUpperCase()
    .replace("PERK VALLEY", "PERKIOMEN VALLEY")
    .replace(/[^A-Z0-9]/g, "");
}

function pacTeam(value: string): Team | undefined {
  return PAC_TEAMS.find((team) => normalized(team) === normalized(value));
}

function todayIso(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
}

function teamUrl(team: Team): string {
  const specialSlugs: Partial<Record<Team, string>> = {
    "Owen J. Roberts": "owen-j-roberts",
    "Pope John Paul II": "pope-john-paul-ii",
  };
  const slug = specialSlugs[team] ?? team.toLowerCase().replaceAll(".", "").replaceAll(" ", "-");
  return `${PIAA_BASE}/2026-${slug}-boys-soccer`;
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(30_000) });
    return response.ok ? await response.text() : null;
  } catch {
    return null;
  }
}

function emptyRecord(): WltRecord {
  return { wins: 0, losses: 0, ties: 0 };
}

function recordString(record: WltRecord): string {
  return `${record.wins}-${record.losses}-${record.ties}`;
}

function parseRecord(value: string): WltRecord | null {
  const match = value.match(/^(\d+)-(\d+)(?:-(\d+))?$/);
  return match ? { wins: Number(match[1]), losses: Number(match[2]), ties: Number(match[3] ?? 0) } : null;
}

function sameRecord(left: WltRecord, right: WltRecord): boolean {
  return left.wins === right.wins && left.losses === right.losses && left.ties === right.ties;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function namedMercuryRecord(text: string, team: Team): { overall: WltRecord; pac: WltRecord } | null {
  const names = TEAM_ALIASES[team].map(escapeRegExp).join("|");
  const match = text.match(new RegExp(`(?:${names})\\s*\\((\\d+-\\d+(?:-\\d+)?),\\s*(\\d+-\\d+(?:-\\d+)?)\\s+PAC\\)`, "i"));
  const overall = match ? parseRecord(match[1]) : null;
  const pac = match ? parseRecord(match[2]) : null;
  return overall && pac ? { overall, pac } : null;
}

function proseMercuryRecord(text: string, team: Team): { overall: WltRecord; pac: WltRecord } | null {
  const names = TEAM_ALIASES[team].map(escapeRegExp).join("|");
  const match = text.match(new RegExp(`(?:${names})\\s+(?:fell to|is now|now stands at|dropped to)\\s+(\\d+-\\d+(?:-\\d+)?)\\s+(?:and|,)\\s*(\\d+-\\d+(?:-\\d+)?)`, "i"));
  const overall = match ? parseRecord(match[1]) : null;
  const pac = match ? parseRecord(match[2]) : null;
  return overall && pac ? { overall, pac } : null;
}

function addGame(record: WltRecord, game: Game): void {
  if (game.teamScore > game.opponentScore) record.wins += 1;
  else if (game.teamScore < game.opponentScore) record.losses += 1;
  else record.ties += 1;
}

function points(record: WltRecord): number {
  return record.wins * 3 + record.ties;
}

function standingKey(row: TeamSummary): string {
  return [row.points, row.pac.wins, row.pac.losses, row.pac.ties].join("|");
}

function parseGames(team: Team, html: string): Game[] {
  const $ = cheerio.load(html);
  const games: Game[] = [];
  const target = normalized(team);

  $("table tbody tr").each((_, row) => {
    const cells = $(row).find("td");
    if (cells.length < 4) return;

    const dateMatch = clean(cells.eq(0).text()).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    const scoreMatch = clean(cells.eq(3).text()).match(/^(\d+)\s*\/\s*(\d+)$/);
    if (!dateMatch || !scoreMatch) return;

    const date = `${dateMatch[3]}-${dateMatch[1]}-${dateMatch[2]}`;
    if (date > todayIso()) return;

    const home = clean(cells.eq(1).text());
    const away = clean(cells.eq(2).text());
    const homeScore = Number(scoreMatch[1]);
    const awayScore = Number(scoreMatch[2]);

    if (normalized(home) === target) games.push({ date, opponent: away, teamScore: homeScore, opponentScore: awayScore });
    else if (normalized(away) === target) games.push({ date, opponent: home, teamScore: awayScore, opponentScore: homeScore });
  });

  return games;
}

async function loadOfficialGames(): Promise<Map<Team, Game[]>> {
  const results = await Promise.all(PAC_TEAMS.map(async (team) => [team, await fetchText(teamUrl(team))] as const));
  const histories = new Map<Team, Game[]>();
  const unavailable: Team[] = [];

  for (const [team, html] of results) {
    if (!html) unavailable.push(team);
    else histories.set(team, parseGames(team, html));
  }

  if (unavailable.length) throw new Error(`PIAA histories unavailable: ${unavailable.join(", ")}`);
  return histories;
}

function calculateStandings(histories: Map<Team, Game[]>): TeamSummary[] {
  return PAC_TEAMS.map((team) => {
    const overall = emptyRecord();
    const pac = emptyRecord();
    const divisionRecord = emptyRecord();
    const division = TEAM_TO_DIVISION.get(team)!;

    for (const game of histories.get(team) ?? []) {
      addGame(overall, game);
      const opponent = pacTeam(game.opponent);
      if (!opponent) continue;

      addGame(pac, game);
      if (TEAM_TO_DIVISION.get(opponent) === division) addGame(divisionRecord, game);
    }

    return { team, division, overall, pac, divisionRecord, points: points(pac) };
  });
}

function boysSoccerParagraphs(html: string): string[] {
  const $ = cheerio.load(html);
  const paragraphs = $(".article-content-wrapper p").toArray();
  const start = paragraphs.findIndex((paragraph) => clean($(paragraph).text()).toLowerCase() === "boys soccer");
  if (start < 0) return [];

  const output: string[] = [];
  for (const paragraph of paragraphs.slice(start + 1)) {
    const text = clean($(paragraph).text());
    if ($(paragraph).find("em").length && text) break;
    if (text) output.push(text);
  }
  return output;
}

async function mercuryCandidates(): Promise<string[]> {
  const found = new Set<string>();
  for (let page = 1; page <= 3; page += 1) {
    const html = await fetchText(page === 1 ? MERCURY_INDEX : `${MERCURY_INDEX}page/${page}/`);
    if (!html) continue;
    const $ = cheerio.load(html);
    $("a[href]").each((_, link) => {
      const url = $(link).attr("href") ?? "";
      if (/^https:\/\/www\.pottsmerc\.com\/\d{4}\/\d{2}\/\d{2}\//.test(url) && /roundup|soccer/i.test(clean($(link).text()))) found.add(url);
    });
  }
  return [...found].sort((left, right) => right.localeCompare(left)).slice(0, 40);
}

async function mercurySnapshots(): Promise<Map<Team, MercurySnapshot>> {
  const snapshots = new Map<Team, MercurySnapshot>();
  for (const articleUrl of await mercuryCandidates()) {
    const html = await fetchText(articleUrl);
    if (!html) continue;

    const paragraphs = boysSoccerParagraphs(html);
    for (const [index, scoreline] of paragraphs.entries()) {
      const score = scoreline.match(/^(.+?)\s+\d+,\s*(.+?)\s+\d+$/);
      if (!score) continue;

      const [firstTeam, secondTeam] = [pacTeam(score[1]), pacTeam(score[2])];
      const recap = paragraphs[index + 1] ?? "";
      const firstRecord = firstTeam ? namedMercuryRecord(recap, firstTeam) : null;
      if (firstTeam && firstRecord && !snapshots.has(firstTeam)) snapshots.set(firstTeam, { ...firstRecord, articleUrl });

      // Mercury sometimes writes the second team's record as prose, e.g.
      // "Pottstown fell to 1-8 and 0-6." The scoreline establishes which team it describes.
      const secondRecord = secondTeam ? namedMercuryRecord(recap, secondTeam) ?? proseMercuryRecord(recap, secondTeam) : null;
      if (secondTeam && secondRecord && !snapshots.has(secondTeam)) {
        snapshots.set(secondTeam, { ...secondRecord, articleUrl });
      }
    }
  }
  return snapshots;
}

function render(standings: TeamSummary[], snapshots: Map<Team, MercurySnapshot>): string {
  const lines = [
    "🏆 **Unofficial PAC Boys Soccer Standings**",
    "",
    "Points: 3 for a PAC win · 1 for a PAC tie · 0 for a loss",
    "Calculated from completed PIAA game histories; Mercury records are a cross-check.",
    "**ST:** Q = projected playoff spot · T = tie at the playoff cutoff",
  ];

  for (const [division, teams] of Object.entries(DIVISIONS)) {
    const rows = standings
      .filter((entry) => entry.division === division)
      .sort((left, right) => right.points - left.points || right.pac.wins - left.pac.wins || left.pac.losses - right.pac.losses || left.team.localeCompare(right.team));

    lines.push("", `**${division} Division**`, "```text", "RK TEAM                DIV    PAC    OVR    PTS ST");
    const cutoffKey = standingKey(rows[1]);
    const tiedAtCutoff = rows.filter((row) => standingKey(row) === cutoffKey).length > 1;
    let priorKey = "";
    let rank = 0;

    for (const [index, row] of rows.entries()) {
      const key = standingKey(row);
      if (key !== priorKey) rank = index + 1;
      priorKey = key;
      const qualifier = rank < 2 ? "Q" : rank === 2 && tiedAtCutoff ? "T" : rank === 2 ? "Q" : "";
      const rankLabel = rank === 2 && tiedAtCutoff ? "2T" : String(rank);
      lines.push(`${rankLabel.padEnd(2)} ${row.team.padEnd(19)} ${recordString(row.divisionRecord).padEnd(6)} ${recordString(row.pac).padEnd(6)} ${recordString(row.overall).padEnd(6)} ${String(row.points).padStart(3)} ${qualifier}`);
    }
    lines.push("```");
    if (tiedAtCutoff) lines.push("⚠️ PAC tie-breaker needed to resolve the playoff cutoff.");
  }

  const confirmations = standings.flatMap((row) => {
    const snapshot = snapshots.get(row.team);
    if (!snapshot) return [];
    const valid = sameRecord(row.overall, snapshot.overall) && sameRecord(row.pac, snapshot.pac);
    return [`${valid ? "✅" : "⚠️"} ${row.team}: Mercury ${recordString(snapshot.overall)} overall / ${recordString(snapshot.pac)} PAC${valid ? " matches PIAA." : " differs from PIAA."}`];
  });

  if (confirmations.length) lines.push("", "📰 **Mercury Record Cross-Checks**", ...confirmations);
  lines.push("", "*Unverified or prose-only Mercury records are intentionally omitted from the cross-check rather than guessed.*");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const standings = calculateStandings(await loadOfficialGames());
  console.log(render(standings, await mercurySnapshots()));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
