"""
"From the frontier" -- new papers in the areas a user actually works on,
for the bottom of the Home page. ZERO model cost: areas come from the user's
own recent Sift runs, papers from public scholarly search, and the result is
cached per user for a day so Home stays fast and the services are not hit on
every visit.

Nothing here is generated: every item is a real search result with its real
link. If the search services cannot be reached, the section is simply empty.

Sources: OpenAlex first (covers every field, has publication dates and
author institutions, free, no key), arXiv as the fallback (the endpoint the
search agent already relies on).
"""
from __future__ import annotations

import json
import re
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import httpx

from core.config import settings
from core.db import _conn, _PH

TTL_HOURS = 24
MAX_AREAS = 4
PER_AREA = 4
POOL = 40                             # papers looked at per area to find who recurs
MAX_LABS = 4
MAX_PEOPLE = 5
CACHE_VERSION = 2
WINDOW_DAYS = 240                     # "recent" = published in roughly the last 8 months
OPENALEX = "https://api.openalex.org/works"
ARXIV = "https://export.arxiv.org/api/query"
UA = {"User-Agent": "Sift-LitReview/1.0 (research assistant; frontier feed)"}

_STOP = set("""a an and or the of in on for to with from by at as is are was were be been being this that these
those it its into about over under between within across via using use used based new novel towards toward how what
why which can could should would may might do does did not no vs versus right now current currently recent recently
study studies paper papers research review reviews survey analysis approach approaches method methods issue issues
opportunities challenges importance impact role part""".split())


def init_frontier_table() -> None:
    with _conn() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS frontier_cache (
                user_id     TEXT PRIMARY KEY,
                fetched_at  TEXT NOT NULL,
                data        TEXT NOT NULL
            )
        """)


def keywords(text: str, limit: int = 7) -> list[str]:
    out = []
    for tok in re.findall(r"[A-Za-z][A-Za-z0-9\-]{2,}", text or ""):
        low = tok.lower()
        if low not in _STOP and low not in out:
            out.append(low)
    return out[:limit]


def _norm(title: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (title or "").lower()).strip()


def areas_for_user(user_id: str) -> list[dict]:
    """The user's most recent distinct lines of work: one per project (or per
    stand-alone run), newest first. The search phrase is the run's own
    reformulated query when Sift produced one, else its research question."""
    ph = _PH
    with _conn() as conn:
        rows = conn.execute(
            f"SELECT s.id, s.topic, s.project_id, s.data, p.name AS project_name "
            f"FROM sessions s LEFT JOIN projects p ON p.id = s.project_id "
            f"WHERE s.user_id = {ph} ORDER BY s.updated_at DESC LIMIT 25",
            (user_id,),
        ).fetchall()
    areas, seen = [], set()
    for r in rows:
        r = dict(r)
        topic = (r.get("topic") or "").strip()
        try:
            data = json.loads(r.get("data") or "{}")
        except Exception:  # noqa: BLE001
            data = {}
        reform = data.get("reform") or {}
        phrase = next((q for q in (reform.get("queries") or []) if isinstance(q, str) and q.strip()), "") or topic
        kws = keywords(phrase)
        if len(kws) < 2 or re.match(r"untitled", topic, re.I):
            continue                                   # nothing specific enough to search on
        key = r.get("project_id") or _norm(topic)
        if key in seen:
            continue
        seen.add(key)
        areas.append({
            "label": r.get("project_name") or topic[:90],
            "topic": topic[:200],
            "project_id": r.get("project_id"),
            "keywords": kws,
            "known": {_norm(p.get("title")) for p in (data.get("papers") or []) if isinstance(p, dict)},
        })
        if len(areas) >= MAX_AREAS:
            break
    return areas


def _openalex(client: httpx.Client, kws: list[str], since: str) -> list[dict]:
    r = client.get(OPENALEX, params={
        "search": " ".join(kws), "filter": f"from_publication_date:{since}",
        "sort": "relevance_score:desc", "per_page": POOL,
        "mailto": getattr(settings, "unpaywall_email", "") or "research@example.com",
    })
    r.raise_for_status()
    out = []
    for w in r.json().get("results") or []:
        loc = w.get("primary_location") or {}
        url = loc.get("landing_page_url") or w.get("doi") or w.get("id")
        title = (w.get("title") or w.get("display_name") or "").strip()
        if not title or not url:
            continue
        auth = w.get("authorships") or []
        inst, people, orgs = [], [], []
        for a in auth:
            au = a.get("author") or {}
            first = None
            for i in a.get("institutions") or []:
                n = i.get("display_name")
                if not n:
                    continue
                first = first or n
                if n not in inst:
                    inst.append(n)
                    orgs.append({"name": n, "id": i.get("id") or "", "ror": i.get("ror") or "",
                                 "country": i.get("country_code") or ""})
            if au.get("display_name"):
                people.append({"name": au["display_name"], "id": au.get("id") or "",
                               "orcid": au.get("orcid") or "", "institution": first or ""})
        out.append({
            "_people": people, "_orgs": orgs,
            "title": re.sub(r"<[^>]+>", "", title),
            "authors": [a.get("author", {}).get("display_name") for a in auth[:3] if a.get("author")],
            "more_authors": max(0, len(auth) - 3),
            "institutions": inst[:2],
            "date": w.get("publication_date") or "",
            "venue": ((loc.get("source") or {}).get("display_name")) or "",
            "url": url,
            "source": "OpenAlex",
        })
    return out


def _arxiv(client: httpx.Client, kws: list[str], since: str) -> list[dict]:
    q = " AND ".join(f"all:{k}" for k in kws[:4])
    r = client.get(ARXIV, params={"search_query": q, "sortBy": "submittedDate", "sortOrder": "descending",
                                  "max_results": 25})
    r.raise_for_status()
    ns = {"a": "http://www.w3.org/2005/Atom"}
    out = []
    for e in ET.fromstring(r.text).findall("a:entry", ns):
        title = " ".join((e.findtext("a:title", "", ns) or "").split())
        url = (e.findtext("a:id", "", ns) or "").strip()
        date = (e.findtext("a:published", "", ns) or "")[:10]
        if not title or not url or (date and date < since):
            continue
        names = [n.findtext("a:name", "", ns) for n in e.findall("a:author", ns)]
        out.append({"_people": [{"name": n, "id": "", "orcid": "", "institution": ""} for n in names if n],
                    "_orgs": [],                           # arXiv lists no affiliations
                    "title": title, "authors": names[:3], "more_authors": max(0, len(names) - 3),
                    "institutions": [], "date": date, "venue": "arXiv", "url": url, "source": "arXiv"})
    return out


def _who(found: list[dict]) -> tuple[list[dict], list[dict]]:
    """Institutions and researchers that recur across an area's recent
    papers. Counted over distinct papers; built only from what the search
    returned -- nobody is named here who is not an author of a listed paper.

    The Google Scholar link is a Scholar *author search* for the person's
    name and institution: Scholar publishes no way to look up a profile's
    address, so a direct profile link could only be a guess."""
    from urllib.parse import quote_plus
    labs: dict[str, dict] = {}
    people: dict[str, dict] = {}
    for it in found:
        for o in it.get("_orgs") or []:
            e = labs.setdefault(o["id"] or o["name"], {**o, "papers": 0, "example": it["title"], "example_url": it["url"]})
            e["papers"] += 1
        for p in it.get("_people") or []:
            e = people.setdefault(p["id"] or p["name"], {**p, "papers": 0, "example": it["title"], "example_url": it["url"]})
            e["papers"] += 1
            e["institution"] = e["institution"] or p["institution"]
    top_labs = sorted(labs.values(), key=lambda x: (-x["papers"], x["name"]))[:MAX_LABS]
    top_people = sorted(people.values(), key=lambda x: (-x["papers"], x["name"]))[:MAX_PEOPLE]
    for l in top_labs:
        l["url"] = l.pop("ror") or l.get("id") or ""
        l.pop("id", None)
    for p in top_people:
        q = quote_plus(f"{p['name']} {p['institution']}".strip())
        p["scholar_search"] = f"https://scholar.google.com/citations?view_op=search_authors&mauthors={q}"
        p["openalex"] = p.pop("id", "")
    # one paper each is just a list of authors, not a signal -- only show when someone recurs
    if top_labs and top_labs[0]["papers"] < 2:
        top_labs = top_labs[:3]
    return top_labs, top_people


def fetch_area(area: dict) -> dict:
    """Recent papers for one area (newest first) plus who recurs in them. Never raises."""
    since = (datetime.now(timezone.utc) - timedelta(days=WINDOW_DAYS)).strftime("%Y-%m-%d")
    kws = area["keywords"]
    found: list[dict] = []
    with httpx.Client(timeout=12, headers=UA, follow_redirects=True) as client:
        for fn, terms in ((_openalex, kws), (_openalex, kws[:4]), (_arxiv, kws)):
            try:
                found = fn(client, terms, since)
            except Exception:  # noqa: BLE001 -- unreachable service or changed response: try the next
                found = []
            if len(found) >= 2:
                break
    labs, people = _who(found)
    seen, out = set(area.get("known") or ()), []
    for it in sorted(found, key=lambda x: x.get("date") or "", reverse=True):
        n = _norm(it["title"])
        if n in seen:
            continue                                   # already in the user's own sources, or a duplicate
        seen.add(n)
        out.append({k: v for k, v in it.items() if not k.startswith("_")})
    return {"items": out[:PER_AREA], "labs": labs, "people": people, "pool": len(found)}


def get_frontier(user_id: str, refresh: bool = False) -> dict:
    ph = _PH
    if not refresh:
        with _conn() as conn:
            row = conn.execute(f"SELECT fetched_at, data FROM frontier_cache WHERE user_id = {ph}", (user_id,)).fetchone()
        if row:
            row = dict(row)
            try:
                age = datetime.now(timezone.utc) - datetime.fromisoformat(row["fetched_at"])
                data = json.loads(row["data"])
                if age < timedelta(hours=TTL_HOURS) and data.get("v") == CACHE_VERSION:
                    return {**data, "fetched_at": row["fetched_at"], "cached": True}
            except Exception:  # noqa: BLE001
                pass

    areas = areas_for_user(user_id)
    if areas:
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(fetch_area, areas))
    else:
        results = []
    out = {"v": CACHE_VERSION, "areas": [
        {"label": a["label"], "topic": a["topic"], "project_id": a["project_id"], **res}
        for a, res in zip(areas, results) if res["items"]
    ], "had_areas": bool(areas)}
    now = datetime.now(timezone.utc).isoformat()
    if out["areas"]:                                   # never cache an empty result: retry next visit
        with _conn() as conn:
            conn.execute(f"DELETE FROM frontier_cache WHERE user_id = {ph}", (user_id,))
            conn.execute(f"INSERT INTO frontier_cache (user_id, fetched_at, data) VALUES ({ph}, {ph}, {ph})",
                         (user_id, now, json.dumps(out)))
    return {**out, "fetched_at": now, "cached": False}
