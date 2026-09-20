#!/usr/bin/env python3
"""Build a verified daily PIAA District 1 PAC boys-soccer report."""
import json
import re
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import requests
from bs4 import BeautifulSoup

BASE_DIR = Path("/home/jim/projects/piaa-rankings")
DATA_DIR = BASE_DIR / "data" / "pac-soccer"
SNAPSHOT_FILE = DATA_DIR / "previous-standings.json"
CURRENT_STANDINGS_FILE = DATA_DIR / "current-standings.json"
CURRENT_GAMES_FILE = DATA_DIR / "current-games.json"
LAST_GAME_SUMMARY_FILE = DATA_DIR / "last-game-summary.json"
ROUNDUP_LEDGER_FILE = DATA_DIR / "pv-roundup-notices.json"
STANDINGS_URL = "https://www.piaad1.org/sports/fall-sports/soccer-b/scores-and-rankings/"
ROUNDUP_INDEX_URL = "https://www.pottsmerc.com/sports/high-school-sports/"
TZ = ZoneInfo("America/New_York")
HEADERS = {"User-Agent": "PAC-Soccer-Daily-Report/1.0 (+local cron job)"}

PAC_DIVISIONS = {
    "Liberty Division": ["Boyertown", "Methacton", "Norristown", "Owen J. Roberts", "Perkiomen Valley", "Spring-Ford"],
    "Frontier Division": ["Phoenixville", "Pope John Paul II", "Pottsgrove", "Pottstown", "Upper Merion", "Upper Perkiomen"],
}
TEAM_URLS = {
    "Phoenixville": "https://www.piaad1.org/sports/fall-sports/soccer-b/scores-and-rankings/games/2026-phoenixville-boys-soccer",
    "Perkiomen Valley": "https://www.piaad1.org/sports/fall-sports/soccer-b/scores-and-rankings/games/2026-perkiomen-valley-boys-soccer",
    "Upper Perkiomen": "https://www.piaad1.org/sports/fall-sports/soccer-b/scores-and-rankings/games/2026-upper-perkiomen-boys-soccer",
    "Spring-Ford": "https://www.piaad1.org/sports/fall-sports/soccer-b/scores-and-rankings/games/2026-spring-ford-boys-soccer",
    "Owen J. Roberts": "https://www.piaad1.org/sports/fall-sports/soccer-b/scores-and-rankings/games/2026-owen-j-roberts-boys-soccer",
    "Boyertown": "https://www.piaad1.org/sports/fall-sports/soccer-b/scores-and-rankings/games/2026-boyertown-boys-soccer",
    "Methacton": "https://www.piaad1.org/sports/fall-sports/soccer-b/scores-and-rankings/games/2026-methacton-boys-soccer",
    "Norristown": "https://www.piaad1.org/sports/fall-sports/soccer-b/scores-and-rankings/games/2026-norristown-boys-soccer",
    "Pope John Paul II": "https://www.piaad1.org/sports/fall-sports/soccer-b/scores-and-rankings/games/2026-pope-john-paul-ii-boys-soccer",
    "Pottsgrove": "https://www.piaad1.org/sports/fall-sports/soccer-b/scores-and-rankings/games/2026-pottsgrove-boys-soccer",
    "Pottstown": "https://www.piaad1.org/sports/fall-sports/soccer-b/scores-and-rankings/games/2026-pottstown-boys-soccer",
    "Upper Merion": "https://www.piaad1.org/sports/fall-sports/soccer-b/scores-and-rankings/games/2026-upper-merion-boys-soccer",
}
NAME_MAP = {
    "BOYERTOWN": "Boyertown", "METHACTON": "Methacton", "NORRISTOWN": "Norristown", "OWEN J. ROBERTS": "Owen J. Roberts", "PERKIOMEN VALLEY": "Perkiomen Valley", "SPRING-FORD": "Spring-Ford", "PHOENIXVILLE": "Phoenixville", "POPE JOHN PAUL II": "Pope John Paul II", "POTTSGROVE": "Pottsgrove", "POTTSTOWN": "Pottstown", "UPPER MERION": "Upper Merion", "UPPER PERKIOMEN": "Upper Perkiomen",
}
ALL_TEAMS = list(NAME_MAP.values())

def now_iso(): return datetime.now(TZ).isoformat()
def clean(text): return " ".join(text.split()).strip()
def write_json(path, value):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, separators=(",", ":")), encoding="utf-8")

def fetch(url):
    try:
        response = requests.get(url, headers=HEADERS, timeout=30)
        response.raise_for_status()
        return response.text, None
    except requests.RequestException as exc:
        return None, f"HTTP request failed: {exc.__class__.__name__}"

def as_integer(text):
    match = re.fullmatch(r"\s*(\d+)\s*", text)
    return int(match.group(1)) if match else None

def table_classification(table):
    heading = table.find_previous(["h1", "h2", "h3", "h4"])
    match = re.search(r"\b([1-4]A)\b", heading.get_text(" ", strip=True) if heading else "", re.I)
    return match.group(1).upper() if match else None

def get_standings():
    retrieved_at = now_iso()
    html, failure = fetch(STANDINGS_URL)
    if failure:
        return {"source_url": STANDINGS_URL, "retrieved_at": retrieved_at, "teams": [], "missing_teams": ALL_TEAMS, "error": failure}
    found, invalid = {}, []
    for table in BeautifulSoup(html, "html.parser").find_all("table"):
        classification = table_classification(table)
        if classification not in {"1A", "2A", "3A", "4A"}: continue
        for row in table.select("tbody tr"):
            school = row.select_one('[data-field="schoolName"]')
            if not school: continue
            team = NAME_MAP.get(clean(school.get_text()).upper())
            if not team: continue
            fields = {cell.get("data-field"): clean(cell.get_text()) for cell in row.find_all("td")}
            cells = row.find_all("td")
            seed = as_integer(clean(cells[0].get_text())) if cells else None
            values = [as_integer(fields.get(key, "")) for key in ("wins", "losses", "ties")]
            if seed is None or any(value is None for value in values) or team in found:
                invalid.append(team)
                continue
            found[team] = {"team": team, "classification": classification, "seed": seed, "wins": values[0], "losses": values[1], "ties": values[2]}
    missing = [team for team in ALL_TEAMS if team not in found]
    error = None if not missing and not invalid else "Standings extraction incomplete"
    return {"source_url": STANDINGS_URL, "retrieved_at": retrieved_at, "teams": list(found.values()), "missing_teams": missing, "error": error}

def parse_date(text):
    try: return datetime.strptime(text, "%m/%d/%Y").date()
    except ValueError: return None

def get_game_history(team):
    url, retrieved_at = TEAM_URLS[team], now_iso()
    html, failure = fetch(url)
    if failure:
        return {"team": team, "source_url": url, "retrieved_at": retrieved_at, "game": None, "error": failure}
    target = next(key for key, value in NAME_MAP.items() if value == team)
    completed = []
    for index, row in enumerate(BeautifulSoup(html, "html.parser").select("table tbody tr")):
        cells = row.find_all("td")
        if len(cells) < 4: continue
        game_date = parse_date(clean(cells[0].get_text()))
        home, visitor, score = (clean(cell.get_text()) for cell in cells[1:4])
        if not game_date or game_date > datetime.now(TZ).date() or re.search(r"postpon|cancel|suspend|tbd|forfeit", score, re.I): continue
        score_match = re.fullmatch(r"(\d+)\s*/\s*(\d+)", score)
        if not score_match: continue
        if clean(home).upper() == target:
            team_score, opponent_score, opponent = int(score_match.group(1)), int(score_match.group(2)), visitor
        elif clean(visitor).upper() == target:
            team_score, opponent_score, opponent = int(score_match.group(2)), int(score_match.group(1)), home
        else: continue
        completed.append((game_date, index, {"date": game_date.isoformat(), "opponent": opponent, "team_score": team_score, "opponent_score": opponent_score, "outcome": "win" if team_score > opponent_score else "loss" if team_score < opponent_score else "tie", "note": None}))
    if not completed:
        return {"team": team, "source_url": url, "retrieved_at": retrieved_at, "game": None, "error": None}
    latest = max(item[0] for item in completed)
    candidates = [item for item in completed if item[0] == latest]
    game = candidates[-1][2]
    if len(candidates) > 1: game["note"] = "Multiple completed games shared the latest date; used the last displayed game."
    return {"team": team, "source_url": url, "retrieved_at": retrieved_at, "game": game, "error": None}

def get_all_completed_games(team):
    """Return every completed live PIAA game for one team, for source cross-checking."""
    html, failure = fetch(TEAM_URLS[team])
    if failure:
        return [], failure
    target = next(key for key, value in NAME_MAP.items() if value == team)
    completed = []
    for row in BeautifulSoup(html, "html.parser").select("table tbody tr"):
        cells = row.find_all("td")
        if len(cells) < 4:
            continue
        game_date = parse_date(clean(cells[0].get_text()))
        home, visitor, score = (clean(cell.get_text()) for cell in cells[1:4])
        score_match = re.fullmatch(r"(\d+)\s*/\s*(\d+)", score)
        if not game_date or game_date > datetime.now(TZ).date() or not score_match:
            continue
        if clean(home).upper() == target:
            team_score, opponent_score, opponent = int(score_match.group(1)), int(score_match.group(2)), visitor
        elif clean(visitor).upper() == target:
            team_score, opponent_score, opponent = int(score_match.group(2)), int(score_match.group(1)), home
        else:
            continue
        completed.append({"date": game_date.isoformat(), "opponent": opponent, "team_score": team_score, "opponent_score": opponent_score})
    return completed, None

def normalized_name(name):
    return re.sub(r"[^A-Z0-9]", "", clean(name).upper().replace("PERK VALLEY", "PERKIOMEN VALLEY"))

def roundup_candidates():
    """Find recent Mercury roundup/article URLs without trusting their titles as sports data."""
    found = []
    for page in range(1, 4):
        url = ROUNDUP_INDEX_URL if page == 1 else f"{ROUNDUP_INDEX_URL}page/{page}/"
        html, failure = fetch(url)
        if failure:
            continue
        for link in BeautifulSoup(html, "html.parser").select("a[href]"):
            href, title = link.get("href", ""), clean(link.get_text(" "))
            if not re.match(r"https://www\.pottsmerc\.com/\d{4}/\d{2}/\d{2}/", href):
                continue
            if not re.search(r"roundup|soccer", title, re.I) or href in found:
                continue
            found.append(href)
    return found[:40]

def roundup_boys_soccer_paragraphs(soup):
    content = soup.select_one(".article-content-wrapper")
    if not content:
        return []
    paragraphs = content.find_all("p")
    start = next((index for index, paragraph in enumerate(paragraphs) if clean(paragraph.get_text(" ")).lower() == "boys soccer"), None)
    if start is None:
        return []
    section = []
    for paragraph in paragraphs[start + 1:]:
        text = clean(paragraph.get_text(" "))
        if paragraph.find("em") and text:
            break
        section.append(text)
    return section

def read_roundup_ledger():
    try:
        ledger = json.loads(ROUNDUP_LEDGER_FILE.read_text(encoding="utf-8"))
        return ledger if isinstance(ledger, dict) and isinstance(ledger.get("delivered"), list) else {"delivered": []}
    except (OSError, json.JSONDecodeError):
        return {"delivered": []}

def find_new_pv_roundup():
    """Find one unannounced Mercury Boys Soccer recap whose score matches live PIAA history."""
    historical_games, failure = get_all_completed_games("Perkiomen Valley")
    if failure:
        return None
    latest_game_date = max((game["date"] for game in historical_games), default=None)
    ledger = read_roundup_ledger()
    delivered = {item.get("game_key") for item in ledger["delivered"] if isinstance(item, dict)}
    for url in roundup_candidates():
        html, failure = fetch(url)
        if failure:
            continue
        section = roundup_boys_soccer_paragraphs(BeautifulSoup(html, "html.parser"))
        if not section:
            continue
        for index, scoreline in enumerate(section):
            score_match = re.fullmatch(r"(.+?)\s+(\d+),\s*(.+?)\s+(\d+)", scoreline)
            if not score_match:
                continue
            left, left_score, right, right_score = score_match.groups()
            left, right = clean(left), clean(right)
            if normalized_name(left) == normalized_name("Perkiomen Valley"):
                opponent, team_score, opponent_score = right, int(left_score), int(right_score)
            elif normalized_name(right) == normalized_name("Perkiomen Valley"):
                opponent, team_score, opponent_score = left, int(right_score), int(left_score)
            else:
                continue
            match = next((game for game in historical_games if normalized_name(game["opponent"]) == normalized_name(opponent) and game["team_score"] == team_score and game["opponent_score"] == opponent_score), None)
            if not match:
                continue
            # A delayed article is useful only for PV's current latest PIAA result;
            # never resurrect a recap for an older game after a newer PV match exists.
            if match["date"] != latest_game_date:
                continue
            game_key = "|".join((match["date"], normalized_name(match["opponent"]), str(team_score), str(opponent_score)))
            if game_key not in delivered:
                recap = section[index + 1] if index + 1 < len(section) else ""
                return {"game_key": game_key, "url": url, "game": match, "recap": recap}
    return None

def read_previous():
    try:
        snapshot = json.loads(SNAPSHOT_FILE.read_text(encoding="utf-8"))
        return snapshot["teams"] if isinstance(snapshot.get("teams"), dict) else {}
    except (OSError, json.JSONDecodeError): return {}

def movement(current, previous):
    result = {}
    for team in ALL_TEAMS:
        value, prior = current.get(team), previous.get(team)
        if not value: result[team] = "❓"
        elif not prior or prior.get("classification") != value["classification"] or not isinstance(prior.get("seed"), int): result[team] = "🆕"
        elif value["seed"] < prior["seed"]: result[team] = "📈"
        elif value["seed"] > prior["seed"]: result[team] = "📉"
        else: result[team] = "⚖️"
    return result

def game_line(team, standing, response):
    if response["error"]: return f"**{team}:** ❓ Most recent result unavailable; source could not be verified."
    game = response["game"]
    if not game: return f"**{team}:** ✨ No completed games recorded."
    symbol = {"win": "✅", "loss": "❌", "tie": "🤝"}[game["outcome"]]
    formatted_date = datetime.strptime(game["date"], "%Y-%m-%d").strftime("%B %-d, %Y")
    margin, reaction = abs(game["team_score"] - game["opponent_score"]), ""
    if team == "Perkiomen Valley": reaction = {"win": " Let’s go, PV!", "tie": " PV earns a point!"}.get(game["outcome"], " A tough, close result for PV." if margin == 1 else "")
    elif game["outcome"] == "win" and margin >= 3: reaction = " Big win!"
    elif game["outcome"] == "win" and margin == 1: reaction = " Tight one!"
    elif game["outcome"] == "tie": reaction = " Nothing between them!"
    elif game["outcome"] == "loss" and margin == 1: reaction = " A close battle!"
    return f"**{team} ({standing['classification']}):** {formatted_date} — {game['team_score']}–{game['opponent_score']} vs. {game['opponent']} {symbol}{reaction}"

def make_pulse(current, previous):
    if not previous:
        leaders = []
        for classification in ("4A", "3A"):
            options = [item for item in current.values() if item["classification"] == classification]
            if options:
                leader = min(options, key=lambda item: item["seed"])
                leaders.append(f"{leader['team']} leads the PAC {classification} group at #{leader['seed']}")
        return "; ".join(leaders) + ". Today establishes the starting point for future movement tracking."
    deltas = [(name, previous[name]["seed"] - value["seed"]) for name, value in current.items() if name in previous and previous[name].get("classification") == value["classification"] and isinstance(previous[name].get("seed"), int)]
    up = max((item for item in deltas if item[1] > 0), default=None, key=lambda item: item[1])
    down = min((item for item in deltas if item[1] < 0), default=None, key=lambda item: item[1])
    steady = sum(delta == 0 for _, delta in deltas)
    sentences = []
    if up: sentences.append(f"{up[0]} made the biggest verified climb, up {up[1]} place{'s' if up[1] != 1 else ''}.")
    if down: sentences.append(f"{down[0]} moved down {abs(down[1])} place{'s' if abs(down[1]) != 1 else ''}.")
    if steady: sentences.append(f"{steady} PAC side{'s' if steady != 1 else ''} held their position.")
    return " ".join(sentences) if sentences else "The PAC board has no comparable movement to report yet."

def read_last_game_summary():
    try:
        snapshot = json.loads(LAST_GAME_SUMMARY_FILE.read_text(encoding="utf-8"))
        games = snapshot.get("games")
        return games if isinstance(games, dict) and set(games) == set(ALL_TEAMS) else None
    except (OSError, json.JSONDecodeError):
        return None

def game_snapshot(games):
    return {response["team"]: response["game"] for response in games}

def has_new_games_since_summary(games, previous_summary):
    """Show full action only for a new/corrected game or an unverifiable source."""
    if any(response["error"] is not None for response in games):
        return True
    return previous_summary is None or game_snapshot(games) != previous_summary

def generate_report(standings, games, moves, previous, has_new_games, roundup):
    current = {item["team"]: item for item in standings["teams"]}
    games_by_team = {item["team"]: item for item in games}
    now, pv = datetime.now(TZ), current.get("Perkiomen Valley")
    lines = ["⚽ **Perkiomen Valley Soccer Daily Update!** ⚽", f"📅 **{now.strftime('%A, %B')} {now.day}, {now.year}**", "", "💙 **PV Check-In**"]
    if pv:
        lines += [f"Rank: **#{pv['seed']}/{pv['classification']}** {moves['Perkiomen Valley']}", f"Record: **{pv['wins']}-{pv['losses']}-{pv['ties']}**", ""]
        recent = games_by_team["Perkiomen Valley"]["game"]
        if not has_new_games:
            lines.append("No new completed PAC games have been recorded since the last full game summary, so this update is all about the standings. 🛡️")
        else:
            lines.append("PV is on the move with a verified win in its latest action! 💪" if recent and recent["outcome"] == "win" else "The Vikings are holding strong in the current District 1 standings. 🛡️")
    else: lines += ["Rank: **Data unavailable ❓**", "Record: **Data unavailable ❓**", "", "PV’s live standing could not be verified this run."]
    if roundup:
        game = roundup["game"]
        formatted_date = datetime.strptime(game["date"], "%Y-%m-%d").strftime("%B %-d, %Y")
        result = "win" if game["team_score"] > game["opponent_score"] else "loss" if game["team_score"] < game["opponent_score"] else "tie"
        lines += ["", "📰 **PV Roundup Spotlight**", f"The Mercury’s Boys Soccer roundup checked in on PV’s {formatted_date} {result}: **{game['team_score']}–{game['opponent_score']} vs. {game['opponent']}**."]
        if roundup["recap"]:
            lines += ["", roundup["recap"]]
        lines += ["", f"⚽ Want more PAC scores and local high-school action? [Catch the full Mercury roundup]({roundup['url']})!"]
    lines += ["", "🔥 **Today’s PAC Pulse**", make_pulse(current, previous), "", "🛡️ **PAC Division Watch**", ""]
    for division, teams in PAC_DIVISIONS.items():
        lines += [f"**{division}**", ""]
        groups = [(None, teams)] if division != "Frontier Division" else [
            ("4A", [team for team in teams if current.get(team, {}).get("classification") == "4A"]),
            ("3A", [team for team in teams if current.get(team, {}).get("classification") == "3A"]),
            ("Unavailable", [team for team in teams if team not in current]),
        ]
        for classification, group_teams in groups:
            ranked = group_teams
            if classification and ranked:
                lines += [f"*{classification} Rankings*", ""]
            # Lower Seed is the stronger rank, so list it first; unavailable teams last.
            for team in sorted(ranked, key=lambda name: (current[name]["seed"], name) if name in current else (float("inf"), name)):
                item = current.get(team)
                lines.append(f"**{team}: #{item['seed']}/{item['classification']} {moves[team]}** — {item['wins']}-{item['losses']}-{item['ties']}" if item else f"**{team}: Data unavailable ❓**")
            if classification:
                lines.append("")
        lines.append("")
    if has_new_games:
        lines += ["⚽ **Latest Action Around the PAC**", "Here’s how each team finished in its most recent completed match:", ""]
        for division, teams in PAC_DIVISIONS.items():
            lines += [f"**{division}**", ""]
            lines.extend(game_line(team, current.get(team, {"classification": "?"}), games_by_team[team]) for team in teams)
            lines.append("")
    else:
        lines += ["📌 **Standings-Only Update**", "No new completed PAC games have been recorded since the last full game summary. The rankings above are today’s full verified update."]
    return "\n".join(lines).rstrip()

def valid_standings(response):
    teams = response["teams"]
    return response["error"] is None and len(teams) == 12 and {item["team"] for item in teams} == set(ALL_TEAMS) and all(item["classification"] in {"1A", "2A", "3A", "4A"} and all(isinstance(item[key], int) for key in ("seed", "wins", "losses", "ties")) for item in teams)

def main():
    standings = get_standings(); write_json(CURRENT_STANDINGS_FILE, standings)
    previous = read_previous(); current = {item["team"]: item for item in standings["teams"]}
    games = [get_game_history(team) for team in ALL_TEAMS]; write_json(CURRENT_GAMES_FILE, games)
    new_games = has_new_games_since_summary(games, read_last_game_summary())
    roundup = find_new_pv_roundup()
    print(generate_report(standings, games, movement(current, previous), previous, new_games, roundup))
    if new_games and all(response["error"] is None for response in games):
        write_json(LAST_GAME_SUMMARY_FILE, {"summary_date": datetime.now(TZ).date().isoformat(), "games": game_snapshot(games)})
    if valid_standings(standings):
        snapshot = {"snapshot_date": datetime.now(TZ).date().isoformat(), "source_url": STANDINGS_URL, "teams": {item["team"]: {"classification": item["classification"], "seed": item["seed"]} for item in standings["teams"]}}
        write_json(SNAPSHOT_FILE, snapshot)
    if roundup:
        ledger = read_roundup_ledger()
        ledger["delivered"].append({"game_key": roundup["game_key"], "article_url": roundup["url"], "delivered_at": now_iso()})
        write_json(ROUNDUP_LEDGER_FILE, ledger)

if __name__ == "__main__": main()
