#!/usr/bin/env node
/**
 * Build an unofficial PAC boys-soccer power ranking from live PIAA data.
 *
 * The ranking is intentionally transparent. It combines each PAC team's
 * District 1 standing, season record, opponent strength, and the quality of
 * results against those opponents. It is not a PAC playoff-seeding system.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as cheerio from "cheerio";

const BASE_DIR = "/home/jim/projects/piaa-rankings";
const DATA_DIR = `${BASE_DIR}/data/pac-soccer`;
const STATE_FILE = `${DATA_DIR}/pac-power-rankings-state.json`;
const D1_SCHEDULE_INDEX_FILE = `${DATA_DIR}/d1-boys-soccer-schedule-index.json`;
const MODEL_VERSION = "d1-network-offense-defense-v1";
const STANDINGS_URL = "https://www.piaad1.org/sports/fall-sports/soccer-b/scores-and-rankings/";
const GAMES_BASE_URL = `${STANDINGS_URL}games`;
const HEADERS = { "User-Agent": "PAC-Soccer-Power-Rankings/1.0 (+local analysis)" };

const PAC_TEAMS = [
  "Boyertown", "Methacton", "Norristown", "Owen J. Roberts", "Perkiomen Valley", "Spring-Ford",
  "Phoenixville", "Pope John Paul II", "Pottsgrove", "Pottstown", "Upper Merion", "Upper Perkiomen",
] as const;

type PacTeam = (typeof PAC_TEAMS)[number];
type WltRecord = { wins: number; losses: number; ties: number };
type PIAAStanding = { school: string; classification: string; seed: number; record: WltRecord; rating: number; scheduleUrl: string };
type Game = { date: string; opponent: string; teamScore: number; opponentScore: number };
type UpcomingGame = { date: string; opponent: string; home: boolean };
type TeamSchedule = { completed: Game[]; upcoming: UpcomingGame[] };
type Opponent = { name: string; standing?: PIAAStanding };
type TeamPower = {
  team: PacTeam;
  record: WltRecord;
  ranking: PIAAStanding;
  games: Game[];
  nextGame?: UpcomingGame;
  latestGame?: Game;
  scoredGames: number;
  unmatchedOpponents: string[];
  piaaStrength: number;
  resultQuality: number;
  scheduleStrength: number;
  recordStrength: number;
  adjustedAttack: number;
  adjustedDefense: number;
  offenseDefenseStrength: number;
  score: number;
};
type NetworkGame = { team: string; opponent: string; teamScore: number; opponentScore: number };
type NetworkRating = { attack: number; defense: number; games: number };
type PriorState = {
  modelVersion?: string;
  gameSnapshot?: string;
  teams?: Record<string, { rank: number; score: number }>;
};
type D1ScheduleIndex = {
  source: string;
  refreshedAt: string;
  teams: Record<string, { school: string; classification: string; scheduleUrl: string }>;
};

const SPECIAL_SLUGS: Partial<Record<PacTeam, string>> = {
  "Owen J. Roberts": "owen-j-roberts",
  "Pope John Paul II": "pope-john-paul-ii",
};

function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalized(value: string): string {
  return clean(value)
    .toUpperCase()
    .replace("PERK VALLEY", "PERKIOMEN VALLEY")
    .replace(/[^A-Z0-9]/g, "");
}

function todayIso(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
}

function displayDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${value}T12:00:00Z`));
}

function recordString(record: WltRecord): string {
  return `${record.wins}-${record.losses}-${record.ties}`;
}

function scoreResult(game: Game): "win" | "loss" | "tie" {
  return game.teamScore > game.opponentScore ? "win" : game.teamScore < game.opponentScore ? "loss" : "tie";
}

function gameSymbol(game: Game): string {
  return scoreResult(game) === "win" ? "✅" : scoreResult(game) === "loss" ? "❌" : "🤝";
}

function gameSlug(team: PacTeam): string {
  const slug = SPECIAL_SLUGS[team] ?? team.toLowerCase().replaceAll(".", "").replaceAll(" ", "-");
  return `${GAMES_BASE_URL}/2026-${slug}-boys-soccer`;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return response.text();
}

function parseStandings(html: string): PIAAStanding[] {
  const $ = cheerio.load(html);
  const rows: PIAAStanding[] = [];
  let classification: string | undefined;

  $("h1,h2,h3,h4,table").each((_, element) => {
    if (/^h[1-4]$/i.test(element.tagName)) {
      classification = clean($(element).text()).match(/\b([1-4]A)\b/i)?.[1].toUpperCase();
      return;
    }
    if (!classification) return;

    $(element).find("tbody tr").each((_, row) => {
      const cells = $(row).find("td");
      const school = clean($(row).find('[data-field="schoolName"]').text());
      const seed = Number(clean(cells.eq(0).text()));
      const wins = Number(clean($(row).find('[data-field="wins"]').text()));
      const losses = Number(clean($(row).find('[data-field="losses"]').text()));
      const ties = Number(clean($(row).find('[data-field="ties"]').text()));
      const rating = Number(clean(cells.eq(5).text()));
      if (!school || !Number.isInteger(seed) || !Number.isFinite(rating)) return;
      const scheduleHref = $(row).find("a.games-link").attr("href");
      if (!scheduleHref) return;
      rows.push({
        school,
        classification: classification!,
        seed,
        record: { wins, losses, ties },
        rating,
        scheduleUrl: new URL(scheduleHref, STANDINGS_URL).toString(),
      });
    });
  });

  return rows;
}

function parseSchedule(team: string, html: string): TeamSchedule {
  const $ = cheerio.load(html);
  const completed: Game[] = [];
  const upcoming: UpcomingGame[] = [];
  const target = normalized(team);

  $("table tbody tr").each((_, row) => {
    const cells = $(row).find("td");
    const rawDate = clean(cells.eq(0).text());
    const dateMatch = rawDate.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!dateMatch) return;
    const date = `${dateMatch[3]}-${dateMatch[1]}-${dateMatch[2]}`;
    const home = clean(cells.eq(1).text());
    const away = clean(cells.eq(2).text());
    const isHome = normalized(home) === target;
    const isAway = normalized(away) === target;
    if (!isHome && !isAway) return;

    const score = clean(cells.eq(3).text()).match(/^(\d+)\s*\/\s*(\d+)$/);
    if (score && date <= todayIso()) {
      completed.push({
        date,
        opponent: isHome ? away : home,
        teamScore: Number(isHome ? score[1] : score[2]),
        opponentScore: Number(isHome ? score[2] : score[1]),
      });
    } else if (!score && date >= todayIso()) {
      upcoming.push({ date, opponent: isHome ? away : home, home: isHome });
    }
  });

  return {
    completed: completed.sort((left, right) => left.date.localeCompare(right.date)),
    upcoming: upcoming.sort((left, right) => left.date.localeCompare(right.date)),
  };
}

function standingStrength(standing: PIAAStanding, classSizes: Map<string, number>): number {
  const size = classSizes.get(standing.classification) ?? standing.seed;
  return size <= 1 ? 1 : (size - standing.seed) / (size - 1);
}

function outcomeValue(game: Game): number {
  return scoreResult(game) === "win" ? 1 : scoreResult(game) === "tie" ? 0.5 : 0;
}

function weightedOpponentStrength(opponent: Opponent, classSizes: Map<string, number>): number | undefined {
  if (!opponent.standing) return undefined;

  // Every opponent in the current District 1 standings is matched from the
  // main PIAA standings page. Blend its class-normalized placement with its
  // current record so a highly seeded team with a weak record (or vice versa)
  // is not represented by position alone.
  const rankingStrength = standingStrength(opponent.standing, classSizes);
  const seasonStrength = recordStrength(opponent.standing.record);
  return rankingStrength * 0.7 + seasonStrength * 0.3;
}

function networkGameKey(team: string, game: Game): string {
  const left = normalized(team);
  const right = normalized(game.opponent);
  return left < right
    ? `${game.date}|${left}|${game.teamScore}|${right}|${game.opponentScore}`
    : `${game.date}|${right}|${game.opponentScore}|${left}|${game.teamScore}`;
}

function buildNetwork(schedules: Map<string, TeamSchedule>): NetworkGame[] {
  const games = new Map<string, NetworkGame>();
  for (const [team, schedule] of schedules) {
    for (const game of schedule.completed) {
      const key = networkGameKey(team, game);
      if (!games.has(key)) games.set(key, { team, opponent: game.opponent, teamScore: game.teamScore, opponentScore: game.opponentScore });
    }
  }
  return [...games.values()];
}

/**
 * Fit a compact, deterministic offense/defense model to the retrieved D1
 * game network. Goals are capped at four: score matters, but a 9-0 result
 * cannot dominate the season. Ratings are shrunk toward average for teams
 * with only a handful of games.
 */
function solveNetworkRatings(games: NetworkGame[]): Map<string, NetworkRating> {
  const names = new Set(games.flatMap((game) => [normalized(game.team), normalized(game.opponent)]));
  const ratings = new Map([...names].map((name) => [name, { attack: 0, defense: 0, games: 0 }]));
  const cappedGoals = games.flatMap((game) => [Math.min(game.teamScore, 4), Math.min(game.opponentScore, 4)]);
  const baseline = cappedGoals.reduce((sum, value) => sum + value, 0) / Math.max(cappedGoals.length, 1);

  for (const game of games) {
    ratings.get(normalized(game.team))!.games += 1;
    ratings.get(normalized(game.opponent))!.games += 1;
  }

  for (let iteration = 0; iteration < 50; iteration += 1) {
    const attackSums = new Map<string, number>();
    const defenseSums = new Map<string, number>();
    const counts = new Map<string, number>();
    const add = (map: Map<string, number>, key: string, value: number) => map.set(key, (map.get(key) ?? 0) + value);

    for (const game of games) {
      const team = normalized(game.team);
      const opponent = normalized(game.opponent);
      const teamRating = ratings.get(team)!;
      const opponentRating = ratings.get(opponent)!;
      const teamGoals = Math.min(game.teamScore, 4);
      const opponentGoals = Math.min(game.opponentScore, 4);

      add(attackSums, team, teamGoals - baseline + opponentRating.defense);
      add(defenseSums, opponent, baseline + teamRating.attack - teamGoals);
      add(counts, team, 1);
      add(counts, opponent, 1);
      add(attackSums, opponent, opponentGoals - baseline + teamRating.defense);
      add(defenseSums, team, baseline + opponentRating.attack - opponentGoals);
    }

    for (const [name, rating] of ratings) {
      const count = counts.get(name) ?? 0;
      const shrinkage = 3;
      const nextAttack = (attackSums.get(name) ?? 0) / (count + shrinkage);
      const nextDefense = (defenseSums.get(name) ?? 0) / (count + shrinkage);
      rating.attack = rating.attack * 0.55 + nextAttack * 0.45;
      rating.defense = rating.defense * 0.55 + nextDefense * 0.45;
    }
  }

  return ratings;
}

function calculatePower(
  team: PacTeam,
  games: Game[],
  nextGame: UpcomingGame | undefined,
  standings: Map<string, PIAAStanding>,
  classSizes: Map<string, number>,
  networkRatings: Map<string, NetworkRating>,
): TeamPower {
  const ranking = standings.get(normalized(team));
  if (!ranking) throw new Error(`Missing PAC team in PIAA standings: ${team}`);

  const record: WltRecord = { wins: 0, losses: 0, ties: 0 };
  const opponentSamples: { game: Game; strength: number }[] = [];
  const unmatchedOpponents = new Set<string>();

  for (const game of games) {
    const result = scoreResult(game);
    if (result === "win") record.wins += 1;
    else if (result === "loss") record.losses += 1;
    else record.ties += 1;

    const opponent: Opponent = { name: game.opponent, standing: standings.get(normalized(game.opponent)) };
    const strength = weightedOpponentStrength(opponent, classSizes);
    if (strength === undefined) unmatchedOpponents.add(game.opponent);
    else opponentSamples.push({ game, strength });
  }

  const completed = games.length;
  const recordStrength = completed ? (record.wins + record.ties * 0.5) / completed : 0;
  const scheduleStrength = opponentSamples.length
    ? opponentSamples.reduce((total, sample) => total + sample.strength, 0) / opponentSamples.length
    : 0;
  // A win over a strong side is worth more than a win over a low-ranked side.
  // The 0.35 floor keeps D1 results meaningful without treating bottom teams as zero-value opponents.
  const resultQuality = opponentSamples.length
    ? opponentSamples.reduce((total, sample) => total + outcomeValue(sample.game) * (0.35 + sample.strength * 0.65), 0) / opponentSamples.length
    : 0;
  const piaaStrength = standingStrength(ranking, classSizes);
  const networkRating = networkRatings.get(normalized(team)) ?? { attack: 0, defense: 0, games: 0 };

  return {
    team,
    record,
    ranking,
    games,
    nextGame,
    latestGame: games.at(-1),
    scoredGames: opponentSamples.length,
    unmatchedOpponents: [...unmatchedOpponents].sort(),
    piaaStrength,
    resultQuality,
    scheduleStrength,
    recordStrength,
    adjustedAttack: networkRating.attack,
    adjustedDefense: networkRating.defense,
    offenseDefenseStrength: 0,
    score: 0,
  };
}

function applyOffenseDefenseStrength(teams: TeamPower[]): TeamPower[] {
  const rawValues = teams.map((team) => team.adjustedAttack - team.adjustedDefense);
  const minimum = Math.min(...rawValues);
  const maximum = Math.max(...rawValues);
  const range = maximum - minimum || 1;

  return teams.map((team) => {
    const offenseDefenseStrength = (team.adjustedAttack - team.adjustedDefense - minimum) / range;
    return {
      ...team,
      offenseDefenseStrength,
      score: team.piaaStrength * 40
        + team.resultQuality * 25
        + team.scheduleStrength * 15
        + team.recordStrength * 10
        + offenseDefenseStrength * 10,
    };
  });
}

function rankTeams(teams: TeamPower[]): TeamPower[] {
  return [...teams].sort((left, right) => right.score - left.score || left.team.localeCompare(right.team));
}

function normalizedRatings(teams: TeamPower[], value: (team: TeamPower) => number): Map<string, number> {
  const values = teams.map(value);
  const minimum = Math.min(...values);
  const range = Math.max(...values) - minimum || 1;
  return new Map(teams.map((team) => [team.team, Math.round(25 + ((value(team) - minimum) / range) * 75)]));
}

function movement(currentRank: number, previousRank?: number): string {
  if (!previousRank) return "🆕—";
  const delta = previousRank - currentRank;
  return delta > 0 ? `🟢▲ ${delta}` : delta < 0 ? `🔴▼ ${Math.abs(delta)}` : "⚪—";
}

function compactMovement(currentRank: number, previousRank?: number): string {
  if (!previousRank) return "🆕—";
  const delta = previousRank - currentRank;
  return delta > 0 ? `🟢▲${delta}` : delta < 0 ? `🔴▼${Math.abs(delta)}` : "⚪—";
}

function pickPhrase(key: string, choices: string[]): string {
  const hash = [...key].reduce((total, character) => (total * 31 + character.charCodeAt(0)) >>> 0, 0);
  return choices[hash % choices.length];
}

function latestImpact(team: TeamPower, standings: Map<string, PIAAStanding>, classSizes: Map<string, number>): string {
  const game = team.latestGame;
  if (!game) return "No completed result is available yet.";
  const opponent = standings.get(normalized(game.opponent));
  const result = scoreResult(game);
  const opponentLabel = opponent
    ? `a #${opponent.seed}/${opponent.classification} D1 opponent (${recordString(opponent.record)})`
    : "an opponent outside the current D1 standings";
  const opponentStrength = opponent ? weightedOpponentStrength({ name: game.opponent, standing: opponent }, classSizes) : undefined;
  const strength = opponentStrength !== undefined && opponentStrength >= 0.65 ? "strong" : opponent ? "limited" : "unrated";
  const scoreline = `${displayDate(game.date)}: ${game.teamScore}–${game.opponentScore} vs. ${properCase(game.opponent)} ${gameSymbol(game)}.`;
  const key = `${team.team}-${game.date}-${result}`;
  if (result === "win") {
    const take = pickPhrase(key, ["banked the three points", "put another result in the win column", "took care of business", "came away smiling"]);
    const value = strength === "strong" ? "That is a meaningful quality win." : "The result counts, though the opponent offers only a modest quality boost.";
    return `${scoreline} ${team.team} ${take}. ${value}`;
  }
  if (result === "tie") {
    const take = pickPhrase(key, ["shared the spoils", "earned a point in a tight one", "held its ground", "left with a draw"]);
    const value = strength === "strong" ? "Against a strong side, that is a useful result." : "It is a steady point, but not a major power-ranking mover.";
    return `${scoreline} ${team.team} ${take}. ${value}`;
  }
  const take = pickPhrase(key, ["ran into a tough afternoon", "could not find enough on the day", "came up short", "took a setback"]);
  const value = strength === "strong" ? "Falling to a strong opponent is less damaging than a loss lower in the table." : "The loss weighs on the results component.";
  return `${scoreline} ${team.team} ${take}. ${value}`;
}

function properCase(value: string): string {
  const pac = PAC_TEAMS.find((team) => normalized(team) === normalized(value));
  return pac ?? clean(value).toLowerCase().replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function recordStrength(record: WltRecord): number {
  const games = record.wins + record.losses + record.ties;
  return games ? (record.wins + record.ties * 0.5) / games : 0.5;
}

function goalsForAndAgainst(games: Game[]): { for: number; against: number } {
  return games.reduce((total, game) => ({ for: total.for + game.teamScore, against: total.against + game.opponentScore }), { for: 0, against: 0 });
}

function projectedScore(
  team: TeamPower,
  powerByTeam: Map<string, TeamPower>,
  standings: Map<string, PIAAStanding>,
  classSizes: Map<string, number>,
): string {
  const next = team.nextGame;
  if (!next) return "🔮 Next: no future PIAA game is currently listed.";

  const pacOpponent = powerByTeam.get(normalized(next.opponent));
  if (pacOpponent) {
    const teamGoals = goalsForAndAgainst(team.games);
    const opponentGoals = goalsForAndAgainst(pacOpponent.games);
    const teamPlayed = Math.max(team.games.length, 1);
    const opponentPlayed = Math.max(pacOpponent.games.length, 1);
    const teamAttack = teamGoals.for / teamPlayed;
    const teamDefense = teamGoals.against / teamPlayed;
    const opponentAttack = opponentGoals.for / opponentPlayed;
    const opponentDefense = opponentGoals.against / opponentPlayed;
    const advantage = (team.score - pacOpponent.score) / 100 + (next.home ? 0.04 : -0.04);
    // Goals allowed are a defensive vulnerability, so a higher value raises
    // the opponent's expected scoring. Keeping both sides of the calculation
    // symmetric guarantees the same matchup is projected identically from
    // either team's report entry.
    const expectedFor = Math.min(5, Math.max(0,
      1.45 + advantage * 2.2 + (teamAttack - 1.45) * 0.28 + (opponentDefense - 1.45) * 0.28,
    ));
    const expectedAgainst = Math.min(5, Math.max(0,
      1.45 - advantage * 2.2 + (opponentAttack - 1.45) * 0.28 + (teamDefense - 1.45) * 0.28,
    ));
    let teamScore = Math.round(expectedFor);
    let opponentScore = Math.round(expectedAgainst);
    if (teamScore === opponentScore && Math.abs(advantage) >= 0.12) {
      if (advantage > 0) teamScore += 1;
      else opponentScore += 1;
    }
    const location = next.home ? "vs." : "at";
    return `🔮 Next: ${displayDate(next.date)} ${location} ${properCase(next.opponent)} — projected ${teamScore}–${opponentScore} (moderate confidence).`;
  }

  const opponent = standings.get(normalized(next.opponent));
  const teamGoals = goalsForAndAgainst(team.games);
  const played = Math.max(team.games.length, 1);
  const teamAttack = teamGoals.for / played;
  const teamDefense = teamGoals.against / played;
  const teamProfile = (team.piaaStrength + recordStrength(team.record)) / 2;
  const opponentProfile = opponent
    ? (standingStrength(opponent, classSizes) + recordStrength(opponent.record)) / 2
    : 0.5;
  const advantage = teamProfile - opponentProfile + (next.home ? 0.04 : -0.04);
  const expectedFor = Math.min(5, Math.max(0, 1.45 + advantage * 2.2 + (teamAttack - 1.5) * 0.28 - (teamDefense - 1.5) * 0.08));
  const expectedAgainst = Math.min(5, Math.max(0, 1.45 - advantage * 2.2 + (teamDefense - 1.5) * 0.28 - (teamAttack - 1.5) * 0.08));
  let teamScore = Math.round(expectedFor);
  let opponentScore = Math.round(expectedAgainst);
  if (teamScore === opponentScore && Math.abs(advantage) >= 0.12) {
    if (advantage > 0) teamScore += 1;
    else opponentScore += 1;
  }

  const location = next.home ? "vs." : "at";
  const confidence = opponent ? "moderate" : "lower";
  return `🔮 Next: ${displayDate(next.date)} ${location} ${properCase(next.opponent)} — projected ${teamScore}–${opponentScore} (${confidence} confidence).`;
}

function teamBlurb(
  team: TeamPower,
  rank: number,
  previousRank: number | undefined,
  powerByTeam: Map<string, TeamPower>,
  offenseRatings: Map<string, number>,
  defenseRatings: Map<string, number>,
  standings: Map<string, PIAAStanding>,
  classSizes: Map<string, number>,
): string {
  const prior = previousRank ? ` ${movement(rank, previousRank)} from #${previousRank}.` : " This is the first baseline.";
  const unmatched = team.unmatchedOpponents.length ? ` ${team.unmatchedOpponents.length} non-D1/unmatched opponent${team.unmatchedOpponents.length === 1 ? " is" : "s are"} excluded from opponent-strength scoring.` : "";
  const profile = pickPhrase(team.team, [
    "The full D1 network—not just the win total—sets this number.",
    "This spot reflects the résumé, schedule, and opponent-adjusted goal profile.",
    "The model is rewarding the whole body of work here.",
    "Strength of schedule and opponent-adjusted scoring both matter in this slot.",
  ]);
  const ratings = `⚽ **Strength Profile**\nAttack **${offenseRatings.get(team.team)}** · Defense **${defenseRatings.get(team.team)}**`;
  return `**#${rank} ${team.team}** — ${recordString(team.record)} overall · ${team.score.toFixed(1)} power points.${prior} ${profile}\n${ratings}\n${latestImpact(team, standings, classSizes)}${unmatched}\n${projectedScore(team, powerByTeam, standings, classSizes)}`;
}

function render(
  teams: TeamPower[],
  previous: PriorState,
  standings: Map<string, PIAAStanding>,
  classSizes: Map<string, number>,
  externalD1Teams: number,
  networkGameCount: number,
): string {
  const ranked = rankTeams(teams);
  const powerByTeam = new Map(teams.map((team) => [normalized(team.team), team]));
  const offenseRatings = normalizedRatings(teams, (team) => team.adjustedAttack);
  const defenseRatings = normalizedRatings(teams, (team) => team.adjustedDefense);
  const priorRanks = previous.teams ?? {};
  const teamColumnWidth = Math.max("TEAM".length, ...ranked.map((team) => team.team.length));
  const lines = [
    "⚡ **Unofficial PAC Power Rankings**",
    `📅 **${new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "America/New_York" }).format(new Date())}**`,
    "",
    "*A transparent strength ranking—not PAC playoff seeding.*",
    "**Formula:** 40% PIAA strength · 25% quality results · 15% schedule strength · 10% overall record · 10% adjusted offense/defense.",
    "*Matched D1 opponents are weighted by current PIAA placement and record; non-D1 opponents are excluded.*",
    "*Attack and defense ratings are opponent-adjusted, scored 25–100 within the PAC; higher is better.*",
    "",
    "```text",
    `RK ${"TEAM".padEnd(teamColumnWidth)} ${"PWR.".padStart(4)}`,
  ];

  ranked.forEach((team, index) => {
    const rank = index + 1;
    const move = compactMovement(rank, priorRanks[team.team]?.rank);
    lines.push(`${String(rank).padStart(2)} ${team.team.padEnd(teamColumnWidth)} ${team.score.toFixed(1).padStart(4)}${move}`);
  });
  lines.push("```", "", "📊 **Rankings Breakdown**", "");

  ranked.forEach((team, index) => lines.push(teamBlurb(team, index + 1, priorRanks[team.team]?.rank, powerByTeam, offenseRatings, defenseRatings, standings, classSizes), ""));
  lines.push(
    "📌 **Data coverage**",
    `Network: 12 PAC teams + ${externalD1Teams} matched non-PAC D1 opponents; ${networkGameCount} completed games analyzed.`,
    "Opponents absent from the current District 1 standings are shown as unmatched and do not receive an invented strength rating.",
  );
  return lines.join("\n").trim();
}

function renderParts(report: string): string[] {
  const breakdown = "📊 **Rankings Breakdown**";
  const start = report.indexOf(breakdown);
  if (start < 0) return [report];
  const body = report.slice(start);
  const teamHeadings = [...body.matchAll(/\n(?=\*\*#\d+ )/g)].map((match) => match.index ?? 0);
  const splitAt = teamHeadings.find((index) => /\*\*#7 /.test(body.slice(index + 1, index + 8)));
  if (splitAt === undefined) return [report];
  return [report.slice(0, start).trimEnd(), body.slice(0, splitAt).trim(), body.slice(splitAt).trim()];
}

async function readState(): Promise<PriorState> {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8")) as PriorState;
  } catch {
    return {};
  }
}

async function writeState(ranked: TeamPower[], gameSnapshot: string): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify({
    modelVersion: MODEL_VERSION,
    generatedAt: new Date().toISOString(),
    gameSnapshot,
    teams: Object.fromEntries(ranked.map((team, index) => [team.team, { rank: index + 1, score: team.score }])),
  }, null, 2));
}

function completedGameSnapshot(schedules: readonly (readonly [PacTeam, TeamSchedule])[]): string {
  return schedules
    .flatMap(([team, schedule]) => schedule.completed.map((game) =>
      `${team}|${game.date}|${normalized(game.opponent)}|${game.teamScore}-${game.opponentScore}`,
    ))
    .sort()
    .join("\n");
}

/**
 * Keep an audit-friendly index of every current D1 boys-soccer schedule URL.
 * The standings page is still refreshed first on every real run, so this is
 * never a stale hard-coded list; it simply means a future PAC opponent's
 * schedule URL is already recorded as soon as it appears in D1 standings.
 */
async function writeD1ScheduleIndex(standings: PIAAStanding[]): Promise<void> {
  const index: D1ScheduleIndex = {
    source: STANDINGS_URL,
    refreshedAt: new Date().toISOString(),
    teams: Object.fromEntries(standings.map((team) => [normalized(team.school), {
      school: team.school,
      classification: team.classification,
      scheduleUrl: team.scheduleUrl,
    }])),
  };
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(D1_SCHEDULE_INDEX_FILE, JSON.stringify(index, null, 2));
}

async function main(): Promise<void> {
  const standings = parseStandings(await fetchText(STANDINGS_URL));
  if (!process.argv.includes("--preview")) await writeD1ScheduleIndex(standings);
  const standingsByName = new Map(standings.map((standing) => [normalized(standing.school), standing]));
  const classSizes = new Map<string, number>();
  for (const standing of standings) classSizes.set(standing.classification, (classSizes.get(standing.classification) ?? 0) + 1);

  const fetchedSchedules = await Promise.all(PAC_TEAMS.map(async (team) => [team, parseSchedule(team, await fetchText(gameSlug(team)))] as const));
  const schedules = new Map<string, TeamSchedule>(fetchedSchedules);
  const externalOpponents = new Map<string, PIAAStanding>();

  for (const [, schedule] of fetchedSchedules) {
    // Include both completed and upcoming non-PAC D1 opponents.  The live
    // standings page exposes the same calendar links used for completed
    // opponents, so known future opponents can contribute their current
    // schedule/record context to the network and projections.
    for (const game of [...schedule.completed, ...schedule.upcoming]) {
      const opponent = standingsByName.get(normalized(game.opponent));
      if (opponent && !PAC_TEAMS.some((team) => normalized(team) === normalized(opponent.school))) {
        externalOpponents.set(normalized(opponent.school), opponent);
      }
    }
  }

  const externalSchedules = await Promise.all([...externalOpponents.values()].map(async (opponent) => [
    opponent.school,
    parseSchedule(opponent.school, await fetchText(opponent.scheduleUrl)),
  ] as const));
  for (const [team, schedule] of externalSchedules) schedules.set(team, schedule);

  const networkGames = buildNetwork(schedules);
  const networkRatings = solveNetworkRatings(networkGames);
  const teams = applyOffenseDefenseStrength(fetchedSchedules.map(([team, schedule]) =>
    calculatePower(team, schedule.completed, schedule.upcoming[0], standingsByName, classSizes, networkRatings),
  ));
  const ranked = rankTeams(teams);
  const loadedPrevious = await readState();
  const previous = loadedPrevious.modelVersion === MODEL_VERSION ? loadedPrevious : {};
  const gameSnapshot = completedGameSnapshot(fetchedSchedules);
  const preview = process.argv.includes("--preview");
  const onlyIfChanged = process.argv.includes("--if-changed");
  if (onlyIfChanged && previous.gameSnapshot === gameSnapshot) return;
  const report = render(teams, previous, standingsByName, classSizes, externalOpponents.size, networkGames.length);
  console.log(process.argv.includes("--parts") ? JSON.stringify(renderParts(report)) : report);
  if (!preview) await writeState(ranked, gameSnapshot);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
