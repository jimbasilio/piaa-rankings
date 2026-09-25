#!/usr/bin/env node
/** Send one-time, PIAA-verified Mercury PAC boys-soccer alerts. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as cheerio from "cheerio";

const BASE_DIR = "/home/jim/projects/piaa-rankings";
const DATA_DIR = `${BASE_DIR}/data/pac-soccer`;
const LEDGER_PATH = `${DATA_DIR}/mercury-alert-state.json`;
const MERCURY_INDEX_URL = "https://www.pottsmerc.com/sports/high-school-sports/";
const HEADERS = { "User-Agent": "PAC-Soccer-Mercury-Alert/1.0 (+local cron job)" };

const PAC_TEAMS = [
  "Boyertown", "Methacton", "Norristown", "Owen J. Roberts", "Perkiomen Valley", "Spring-Ford",
  "Phoenixville", "Pope John Paul II", "Pottsgrove", "Pottstown", "Upper Merion", "Upper Perkiomen",
];

const HEADLINES = [
  "🔥 **HOT OFF THE PRESS!**", "🚨 **THIS JUST IN!**", "📰 **FRESH FROM THE MERCURY!**",
  "⚡ **BREAKING PAC SOCCER NEWS!**", "📣 **JUST IN FROM THE LOCAL SOCCER DESK!**",
  "🎉 **NEW PAC ROUNDUP ALERT!**", "👀 **THE LATEST SCOOP IS IN!**", "🏃 **STRAIGHT FROM THE SIDELINES!**",
  "📬 **A FRESH SOCCER UPDATE HAS ARRIVED!**", "🌟 **NEW LOCAL SOCCER COVERAGE!**",
  "🎙️ **THE MERCURY HAS THE LATEST!**", "⚽ **PAC SOCCER NEWS JUST DROPPED!**", "🔔 **ROUNDUP UPDATE!**",
  "💥 **THE NEWEST SOCCER SCOOP IS HERE!**", "🗞️ **EXTRA! EXTRA! READ ALL ABOUT IT!**",
  "🚀 **THE PAC NEWS TRAIN JUST ARRIVED!**", "🏟️ **FROM THE PITCH TO THE PRESS!**",
  "🎯 **A BRAND-NEW PAC RECAP IS IN!**", "🙌 **GOOD NEWS FROM THE SOCCER BEAT!**",
  "🌐 **PAC COVERAGE UPDATE!**", "🔎 **THE LATEST ROUNDUP HAS LANDED!**", "💙 **LOCAL SOCCER SPOTLIGHT!**",
  "📢 **NEWS FLASH FROM THE PAC!**", "✨ **FRESH MATCH COVERAGE!**",
];

type Game = { date: string; opponent: string; teamScore: number; opponentScore: number };
type VerifiedMatch = { team: string; game: Game; recap: string };
type Ledger = { articles?: string[]; checked_articles?: string[]; last_checked_date?: string; delivered_at?: string };

function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalized(value: string): string {
  return clean(value)
    .toUpperCase()
    .replace(/[.'’]/g, "")
    .replace(/\s+/g, " ")
    .replace("PERK VALLEY", "PERKIOMEN VALLEY");
}

function displayTeam(value: string): string {
  const pacTeam = PAC_TEAMS.find((team) => normalized(team) === normalized(value));
  if (pacTeam) return pacTeam;
  return clean(value).toLowerCase().replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function todayIso(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
}

function teamUrl(team: string): string {
  const specialSlugs: Record<string, string> = {
    "Owen J. Roberts": "owen-j-roberts",
    "Pope John Paul II": "pope-john-paul-ii",
  };
  const slug = specialSlugs[team] ?? team.toLowerCase().replaceAll(".", "").replaceAll(" ", "-");
  return `https://www.piaad1.org/sports/fall-sports/soccer-b/scores-and-rankings/games/2026-${slug}-boys-soccer`;
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(30_000) });
    return response.ok ? await response.text() : null;
  } catch {
    return null;
  }
}

async function readLedger(): Promise<Ledger> {
  try {
    return JSON.parse(await readFile(LEDGER_PATH, "utf8")) as Ledger;
  } catch {
    return {};
  }
}

async function writeLedger(ledger: Ledger): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(LEDGER_PATH, JSON.stringify({
    ...ledger,
    delivered_at: new Date().toISOString(),
  }), "utf8");
}

function articleDate(url: string): string {
  return url.match(/\/(\d{4})\/(\d{2})\/(\d{2})\//)?.slice(1).join("-") ?? "";
}

function parseGameHistory(team: string, html: string): Game[] {
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

async function loadOfficialHistories(): Promise<Map<string, Game[]>> {
  const responses = await Promise.all(PAC_TEAMS.map(async (team) => [team, await fetchText(teamUrl(team))] as const));
  const histories = new Map<string, Game[]>();
  for (const [team, html] of responses) if (html) histories.set(team, parseGameHistory(team, html));
  return histories;
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

async function roundupCandidates(): Promise<string[]> {
  const found = new Set<string>();
  for (let page = 1; page <= 3; page += 1) {
    const url = page === 1 ? MERCURY_INDEX_URL : `${MERCURY_INDEX_URL}page/${page}/`;
    const html = await fetchText(url);
    if (!html) continue;
    const $ = cheerio.load(html);
    $("a[href]").each((_, link) => {
      const href = $(link).attr("href") ?? "";
      const title = clean($(link).text());
      const isArticle = /^https:\/\/www\.pottsmerc\.com\/\d{4}\/\d{2}\/\d{2}\//.test(href);
      if (isArticle && /roundup|soccer/i.test(title)) found.add(href);
    });
  }
  // Keep page order for same-day stories, but never let a prior-day roundup
  // leapfrog a newer one because of link/DOM order.
  const publicationDate = (url: string) => url.match(/\/(\d{4})\/(\d{2})\/(\d{2})\//)?.slice(1).join("-") ?? "";
  return [...found]
    .sort((left, right) => publicationDate(right).localeCompare(publicationDate(left)))
    .slice(0, 40);
}

function verifiedMatches(paragraphs: string[], histories: Map<string, Game[]>): VerifiedMatch[] {
  const matches: VerifiedMatch[] = [];
  const seenGames = new Set<string>();
  for (const [index, paragraph] of paragraphs.entries()) {
    const score = paragraph.match(/^(.+?)\s+(\d+),\s*(.+?)\s+(\d+)$/);
    if (!score) continue;

    const [, firstTeam, firstScore, secondTeam, secondScore] = score;
    // The first-listed Mercury team owns the recap, avoiding PAC-vs-PAC duplicates.
    const team = PAC_TEAMS.find((candidate) => normalized(candidate) === normalized(firstTeam));
    if (!team) continue;
    const game = histories.get(team)?.find((candidate) =>
      normalized(candidate.opponent) === normalized(secondTeam) &&
      candidate.teamScore === Number(firstScore) &&
      candidate.opponentScore === Number(secondScore));
    if (!game) continue;

    const key = `${team}|${game.date}|${game.teamScore}|${game.opponentScore}|${normalized(game.opponent)}`;
    if (seenGames.has(key)) continue;
    seenGames.add(key);
    matches.push({ team, game, recap: paragraphs[index + 1] ?? "" });
  }
  return matches;
}

function renderAlert(articleUrl: string, matches: VerifiedMatch[]): string {
  const pv = matches.find((match) => match.team === "Perkiomen Valley");
  const otherMatches = matches.filter((match) => match.team !== "Perkiomen Valley");
  const lines = [
    HEADLINES[new Date().getDate() % HEADLINES.length],
    "",
    pv
      ? `⚽ **Perkiomen Valley: ${pv.game.teamScore}–${pv.game.opponentScore} vs. ${displayTeam(pv.game.opponent)}**`
      : "⚽ **A new PAC soccer roundup is here!**",
  ];

  if (pv?.recap) lines.push("", pv.recap);
  if (otherMatches.length) {
    lines.push("", "🏟️ **Elsewhere in PAC Game Summaries**");
    for (const match of otherMatches) {
      lines.push("", `**${match.team}: ${match.game.teamScore}–${match.game.opponentScore} vs. ${displayTeam(match.game.opponent)}**`);
      if (match.recap) lines.push(match.recap);
    }
  }
  lines.push("", `📰 [Read the full Mercury roundup](${articleUrl}) for more PAC soccer and local high-school action!`);
  return lines.join("\n");
}

async function main(): Promise<void> {
  const ledger = await readLedger();
  const deliveredArticles = new Set(ledger.articles ?? []);
  const checkedArticles = new Set(ledger.checked_articles ?? []);
  const histories = await loadOfficialHistories();

  // This is a live alert, not a historical roundup backfill. Only inspect
  // articles on or after the newest date already checked. This still scans
  // every article published on that date, since several stories can arrive
  // on the same day and only some may contain a Boys Soccer section.
  const candidates = await roundupCandidates();
  const boundary = ledger.last_checked_date
    ?? [...deliveredArticles].map(articleDate).filter(Boolean).sort().at(-1)
    ?? "";
  let newestCheckedDate = boundary;

  for (const articleUrl of candidates) {
    const date = articleDate(articleUrl);
    if (!date || (boundary && date < boundary) || checkedArticles.has(articleUrl)) continue;
    if (date > newestCheckedDate) newestCheckedDate = date;

    const articleHtml = await fetchText(articleUrl);
    checkedArticles.add(articleUrl);
    if (!articleHtml) continue;

    const matches = verifiedMatches(boysSoccerParagraphs(articleHtml), histories);
    if (!matches.length) continue;

    console.log(renderAlert(articleUrl, matches));
    deliveredArticles.add(articleUrl);
    await writeLedger({
      articles: [...deliveredArticles],
      checked_articles: [...checkedArticles],
      last_checked_date: newestCheckedDate,
    });
    return;
  }

  if (newestCheckedDate !== boundary || checkedArticles.size !== (ledger.checked_articles ?? []).length) {
    await writeLedger({
      articles: [...deliveredArticles],
      checked_articles: [...checkedArticles],
      last_checked_date: newestCheckedDate,
    });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
