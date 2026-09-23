#!/usr/bin/env node
/**
 * Calculate unofficial PAC boys-soccer standings from completed PIAA games.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as cheerio from "cheerio";

const PIAA_BASE = "https://www.piaad1.org/sports/fall-sports/soccer-b/scores-and-rankings/games";
const HEADERS = { "User-Agent": "PAC-Soccer-Standings/1.0 (+local cron job)" };
const STATE_FILE = "/home/jim/projects/piaa-rankings/data/pac-soccer/pac-standings-state.json";

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
type WltRecord = { wins: number; losses: number; ties: number };
type Game = { date: string; opponent: string; teamScore: number; opponentScore: number };
type TeamSummary = {
  team: Team;
  division: string;
  overall: WltRecord;
  pac: WltRecord;
  divisionRecord: WltRecord;
  points: number;
  divisionPoints: number;
};
type StandingsState = { snapshot: string };

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

function divisionStandingKey(row: TeamSummary): string {
  return [
    row.divisionPoints,
    row.divisionRecord.wins,
    row.divisionRecord.losses,
    row.divisionRecord.ties,
  ].join("|");
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

    return {
      team,
      division,
      overall,
      pac,
      divisionRecord,
      points: points(pac),
      divisionPoints: points(divisionRecord),
    };
  });
}

function standingsSnapshot(standings: TeamSummary[]): string {
  return JSON.stringify(
    standings
      .map((row) => ({
        team: row.team,
        division: recordString(row.divisionRecord),
        pac: recordString(row.pac),
        overall: recordString(row.overall),
      }))
      .sort((left, right) => left.team.localeCompare(right.team)),
  );
}

async function readState(): Promise<StandingsState | null> {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8")) as StandingsState;
  } catch {
    return null;
  }
}

async function writeState(snapshot: string): Promise<void> {
  await mkdir(new URL(".", `file://${STATE_FILE}`).pathname, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify({ snapshot }), "utf8");
}

function comparePacPoints(left: TeamSummary, right: TeamSummary): number {
  return right.points - left.points || right.pac.wins - left.pac.wins || left.pac.losses - right.pac.losses || left.team.localeCompare(right.team);
}

function compareDivisionPoints(left: TeamSummary, right: TeamSummary): number {
  return right.divisionPoints - left.divisionPoints || right.divisionRecord.wins - left.divisionRecord.wins || left.divisionRecord.losses - right.divisionRecord.losses || left.team.localeCompare(right.team);
}

function tiedOnDivisionPoints(rows: TeamSummary[]): boolean {
  return rows.length > 1 && rows[0].divisionPoints === rows[1].divisionPoints;
}

function render(standings: TeamSummary[]): string {
  const lines = [
    "🏆 **Unofficial PAC Boys Soccer Standings**",
    "",
    "Points: 3 for a PAC win · 1 for a PAC tie · 0 for a loss",
    "Calculated from completed PIAA game histories.",
    "",
    "**How we believe the PAC Final Four works**",
    "• The Liberty and Frontier division champions receive automatic bids, based on division play.",
    "• The next two spots are wild cards, based on PAC/conference points (including crossover games).",
    "• Conference points likely order the four seeds, but the PAC has not published its current tie-break procedure.",
  ];

  const divisionChampions: TeamSummary[] = [];
  const divisionRaces = new Map<string, TeamSummary[]>();

  for (const [division, teams] of Object.entries(DIVISIONS)) {
    const pacRows = standings
      .filter((entry) => entry.division === division)
      .sort(comparePacPoints);

    // Division tables show the division-title race, so they must be ordered
    // by division points—not conference points. PAC points remain visible for
    // the separate wild-card comparison below.
    const rows = [...pacRows].sort(compareDivisionPoints);
    const divisionRace = rows;
    divisionRaces.set(division, divisionRace);
    const divisionLeader = divisionRace[0];
    if (!tiedOnDivisionPoints(divisionRace)) divisionChampions.push(divisionLeader);

    lines.push(
      "",
      `**${division} Division**`,
      "*Division-title race — ordered by division points.*",
      "```text",
      `${"RK".padEnd(2)} ${"TEAM".padEnd(17)} ${"DIV".padEnd(5)} ${"DP".padStart(2)}`,
    );
    let priorKey = "";
    let rank = 0;

    for (const [index, row] of rows.entries()) {
      const key = divisionStandingKey(row);
      if (key !== priorKey) rank = index + 1;
      priorKey = key;
      const tied = rows.filter((candidate) => divisionStandingKey(candidate) === key).length > 1;
      const rankLabel = `${rank}${tied ? "T" : ""}`;
      // This fixed-width row is deliberately capped at 29 characters so it
      // remains intact in narrow WhatsApp chat windows.
      lines.push(`${rankLabel.padEnd(2)} ${row.team.padEnd(17)} ${recordString(row.divisionRecord)} ${String(row.divisionPoints).padStart(2)}`);
    }
    lines.push("```");
    if (tiedOnDivisionPoints(divisionRace)) {
      lines.push(`⚠️ **Division title race:** ${divisionRace[0].team} and ${divisionRace[1].team} are tied on division points; official PAC tie-breaker needed.`);
    } else {
      lines.push(`🏁 **Division leader:** ${divisionLeader.team} — ${recordString(divisionLeader.divisionRecord)} in division play (${divisionLeader.divisionPoints} points).`);
    }

    lines.push("", `**${division} Details**`);
    for (const row of rows) {
      lines.push(`• ${row.team}`, `  PAC ${recordString(row.pac)} (${row.points} pts)`, `  Overall ${recordString(row.overall)}`);
    }
  }

  const unresolvedDivisionRaces = [...divisionRaces.entries()].filter(([, rows]) => tiedOnDivisionPoints(rows));
  lines.push("", "🎟️ **PAC Final Four Watch — Unofficial**");

  if (unresolvedDivisionRaces.length) {
    lines.push("The projected field is intentionally **not** named yet: a division championship is tied, and that result changes the wild-card pool.");
    for (const [division, rows] of unresolvedDivisionRaces) {
      lines.push(`• **${division} title race:** ${rows[0].team} and ${rows[1].team} are tied on division points.`);
    }
    lines.push("", "**PAC-points wild-card watch**");
    lines.push("These are the conference-points leaders, but they are not labeled wild cards until the division title race is resolved:");
    standings.sort(comparePacPoints).slice(0, 4).forEach((team) => {
      lines.push(`• **${team.team}** — ${recordString(team.pac)} PAC (${team.points} points)`);
    });
  } else {
    const divisionLeaderNames = new Set(divisionChampions.map((row) => row.team));
    const wildCardPool = standings.filter((row) => !divisionLeaderNames.has(row.team)).sort(comparePacPoints);
    const wildCards = wildCardPool.slice(0, 2);
    const projectedFinalFour = [...divisionChampions, ...wildCards].sort(comparePacPoints);

    for (const champion of divisionChampions.sort((left, right) => left.division.localeCompare(right.division))) {
      lines.push(`• **${champion.team}** — ${champion.division} leader; automatic-bid projection.`);
    }
    for (const wildCard of wildCards) {
      lines.push(`• **${wildCard.team}** — wild-card projection; ${recordString(wildCard.pac)} PAC (${wildCard.points} points).`);
    }
    lines.push("", "**Provisional seed order by PAC points**");
    projectedFinalFour.forEach((team, index) => lines.push(`${index + 1}. ${team.team} — ${team.points} PAC points`));
    if (wildCardPool.length > 2 && wildCardPool[1].points === wildCardPool[2].points) {
      lines.push("⚠️ The final wild-card line is tied on PAC points; official PAC tie-breaker needed.");
    }
  }

  return lines.join("\n");
}

async function main(): Promise<void> {
  const standings = calculateStandings(await loadOfficialGames());
  const snapshot = standingsSnapshot(standings);
  const mode = process.argv[2];

  if (mode === "--mark-sent") {
    await writeState(snapshot);
    return;
  }

  if (mode === "--send-if-changed") {
    if ((await readState())?.snapshot === snapshot) return;
    // The automation suppresses empty output. Update the ledger only when a
    // changed report is about to be emitted for delivery.
    await writeState(snapshot);
  }

  console.log(render(standings));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
