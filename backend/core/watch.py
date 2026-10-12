"""
"Scholars to watch / Laboratories to watch" -- researchers and labs a user
follows, and the papers they have published lately. Zero model cost: every
paper comes from OpenAlex (free, no key), looked up by the OpenAlex author or
institution ID the user chose.

"New" means: a paper published in the last WINDOW_DAYS that the user has not
yet marked as seen. Following someone marks their current papers as seen, so
only papers that appear after you follow them light up.

Each follow's paper list is cached for CHECK_HOURS, so opening Home does not
hit OpenAlex on every visit.
"""
from __future__ import annotations

import json
import re
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import httpx

from core.config import settings
from core.db import _conn, _PH

API = "https://api.openalex.org"
UA = {"User-Agent": "Sift-LitReview/1.0 (research assistant; watch list)"}
WINDOW_DAYS = 180          # how far back "recent papers" reaches
PER_FOLLOW = 6             # papers kept per follow
CHECK_HOURS = 6            # re-check OpenAlex at most this often per follow
MAX_FOLLOWS = 60
KINDS = ("scholar", "lab")
# "group": a lab set up by the user from its members. Most research groups
# (e.g. a university lab like REVT at UT Dallas) are not OpenAlex
# institutions, but their members are OpenAlex authors -- so a group's papers
# are its members' papers.
MAX_MEMBERS = 40
_GENERIC = set("""lab labs laboratory laboratories center centre group institute research team
the and of for in on at a an""".split())


def init_watch_table() -> None:
    with _conn() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS watch_follows (
                id          TEXT PRIMARY KEY,
                user_id     TEXT NOT NULL,
                kind        TEXT NOT NULL,
                openalex_id TEXT NOT NULL,
                name        TEXT NOT NULL,
                created_at  TEXT NOT NULL,
                checked_at  TEXT,
                data        TEXT NOT NULL
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_watch_user ON watch_follows (user_id)")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def short_id(v: str) -> str:
    """'https://openalex.org/A5023888391' -> 'A5023888391' (also accepts the short form)."""
    m = re.search(r"([AI]\d{4,})\s*$", (v or "").strip(), re.I)
    return m.group(1).upper() if m else ""


def _mailto() -> str:
    return getattr(settings, "unpaywall_email", "") or "research@example.com"


# ── OpenAlex lookups ────────────────────────────────────────────────────────
def search(kind: str, q: str, institution: str = "") -> list[dict]:
    """People or institutions matching a name, for the Follow search box.
    `institution` narrows people to those whose latest affiliation is there."""
    q = (q or "").strip()
    if kind not in KINDS or len(q) < 2:
        return []
    path = "authors" if kind == "scholar" else "institutions"
    params = {"search": q, "per_page": 15, "mailto": _mailto()}
    inst = short_id(institution)
    if kind == "scholar" and inst:
        params["filter"] = f"last_known_institutions.id:{inst}"
    with httpx.Client(timeout=12, headers=UA, follow_redirects=True) as c:
        r = c.get(f"{API}/{path}", params=params)
        r.raise_for_status()
        rows = r.json().get("results") or []
        if not rows and not inst:
            # Full-text search needs whole words; autocomplete also matches a
            # partly typed name ("Fei-Fe"). It returns short records, so look
            # the matches up again to get institutions and topics.
            a = c.get(f"{API}/autocomplete/{path}", params={"q": q, "mailto": _mailto()})
            a.raise_for_status()
            ids = [short_id(x.get("id", "")) for x in (a.json().get("results") or [])][:10]
            ids = [i for i in ids if i]
            if ids:
                r = c.get(f"{API}/{path}", params={"filter": "openalex:" + "|".join(ids), "per_page": 10,
                                                    "mailto": _mailto()})
                r.raise_for_status()
                rows = r.json().get("results") or []
    # Many people share a name: put the most-cited first, which is usually the one meant.
    rows.sort(key=lambda x: -(x.get("cited_by_count") or 0))
    out = []
    for x in rows:
        if kind == "scholar":
            insts = x.get("last_known_institutions") or []
            topics = [t.get("display_name") for t in (x.get("topics") or [])[:2] if t.get("display_name")]
            sub = ", ".join(filter(None, [(insts[0] or {}).get("display_name") if insts else "", "; ".join(topics)]))
        else:
            sub = " · ".join(filter(None, [(x.get("type") or "").replace("_", " "), x.get("country_code") or ""]))
        out.append({
            "openalex_id": short_id(x.get("id", "")), "name": x.get("display_name") or "",
            "subtitle": sub, "works_count": x.get("works_count") or 0,
            "cited_by_count": x.get("cited_by_count") or 0,
        })
    return [o for o in out if o["openalex_id"] and o["name"]][:8]


def suggest_members(institution: str, topic: str) -> list[dict]:
    """People at an institution who publish on a lab's topic -- candidates for a
    lab's member list. Counted over the institution's papers matching the lab's
    name or topic in the last three years; only authors affiliated with that
    institution on those papers are counted."""
    inst = short_id(institution)
    words = [w for w in re.findall(r"[A-Za-z][A-Za-z0-9\-]+", topic or "") if w.lower() not in _GENERIC]
    if not inst or not words:
        return []
    since = (datetime.now(timezone.utc) - timedelta(days=3 * 365)).strftime("%Y-%m-%d")
    with httpx.Client(timeout=15, headers=UA, follow_redirects=True) as c:
        r = c.get(f"{API}/works", params={"search": " ".join(words[:8]),
                                          "filter": f"institutions.id:{inst},from_publication_date:{since}",
                                          "per_page": 100, "mailto": _mailto()})
        r.raise_for_status()
        rows = r.json().get("results") or []
    people: dict[str, dict] = {}
    for w in rows:
        for a in w.get("authorships") or []:
            if not any(short_id(i.get("id", "")) == inst for i in a.get("institutions") or []):
                continue
            au = a.get("author") or {}
            aid = short_id(au.get("id", ""))
            if not aid or not au.get("display_name"):
                continue
            e = people.setdefault(aid, {"openalex_id": aid, "name": au["display_name"], "papers": 0,
                                        "example": re.sub(r"<[^>]+>", "", w.get("title") or "")})
            e["papers"] += 1
    return sorted(people.values(), key=lambda x: (-x["papers"], x["name"]))[:15]


def recent_works(kind: str, oid: str, keywords: list[str] | None = None,
                 members: list[dict] | None = None) -> list[dict]:
    """Newest papers by a scholar, from an institution (optionally only those
    matching keywords), or by any member of a user-defined lab."""
    since = (datetime.now(timezone.utc) - timedelta(days=WINDOW_DAYS)).strftime("%Y-%m-%d")
    if kind == "group":
        ids = [short_id(m.get("openalex_id", "")) for m in (members or [])]
        ids = [i for i in ids if i][:MAX_MEMBERS]
        if not ids:
            return []
        field, oid = "author.id", "|".join(ids)
    else:
        field = "author.id" if kind == "scholar" else "institutions.id"
    params = {"filter": f"{field}:{oid},from_publication_date:{since}",
              "sort": "publication_date:desc", "per_page": 15, "mailto": _mailto()}
    if kind == "lab" and keywords:
        params["search"] = " ".join(keywords[:5])
    with httpx.Client(timeout=12, headers=UA, follow_redirects=True) as c:
        r = c.get(f"{API}/works", params=params)
        r.raise_for_status()
        rows = r.json().get("results") or []
    out, seen = [], set()
    for w in rows:
        title = re.sub(r"<[^>]+>", "", (w.get("title") or w.get("display_name") or "")).strip()
        loc = w.get("primary_location") or {}
        url = loc.get("landing_page_url") or w.get("doi") or w.get("id")
        key = re.sub(r"[^a-z0-9]+", " ", title.lower()).strip()
        if not title or not url or key in seen:
            continue
        seen.add(key)
        auth = w.get("authorships") or []
        out.append({
            "id": (w.get("id") or url).rsplit("/", 1)[-1],
            "title": title,
            "authors": [a.get("author", {}).get("display_name") for a in auth[:3] if a.get("author")],
            "more_authors": max(0, len(auth) - 3),
            "venue": ((loc.get("source") or {}).get("display_name")) or "",
            "date": w.get("publication_date") or "",
            "url": url,
        })
        if len(out) >= PER_FOLLOW:
            break
    return out


# ── storage ─────────────────────────────────────────────────────────────────
def _row(r) -> dict:
    r = dict(r)
    data = json.loads(r.get("data") or "{}")
    return {"id": r["id"], "kind": r["kind"], "openalex_id": r["openalex_id"], "name": r["name"],
            "created_at": r["created_at"], "checked_at": r.get("checked_at"), **data}


def _save(f: dict) -> None:
    keep = {k: f.get(k) for k in ("subtitle", "keywords", "scope", "works", "seen", "error",
                                  "institution", "members", "website")}
    with _conn() as conn:
        conn.execute(f"UPDATE watch_follows SET checked_at = {_PH}, data = {_PH} WHERE id = {_PH}",
                     (f.get("checked_at"), json.dumps(keep), f["id"]))


def list_follows(user_id: str) -> list[dict]:
    with _conn() as conn:
        rows = conn.execute(f"SELECT * FROM watch_follows WHERE user_id = {_PH} ORDER BY created_at DESC",
                            (user_id,)).fetchall()
    return [_row(r) for r in rows]


def add_follow(user_id: str, kind: str, openalex_id: str, name: str, subtitle: str = "",
               keywords: list[str] | None = None, scope: str = "") -> dict:
    oid = short_id(openalex_id)
    if kind not in KINDS or not oid or not (name or "").strip():
        raise ValueError("Pick a researcher or laboratory from the search results.")
    if (kind == "scholar") != oid.startswith("A"):
        raise ValueError("That ID is not a " + ("researcher" if kind == "scholar" else "laboratory") + ".")
    existing = [f for f in list_follows(user_id) if f["kind"] == kind and f["openalex_id"] == oid]
    if existing:
        return existing[0]
    if len(list_follows(user_id)) >= MAX_FOLLOWS:
        raise ValueError(f"You can watch up to {MAX_FOLLOWS} scholars and laboratories.")
    kws = [k for k in (keywords or []) if isinstance(k, str) and k.strip()][:6]
    fid, now = str(uuid.uuid4()), _now()
    data = {"subtitle": (subtitle or "")[:200], "keywords": kws, "scope": (scope or "")[:120],
            "works": [], "seen": [], "error": None}
    with _conn() as conn:
        conn.execute(f"INSERT INTO watch_follows (id, user_id, kind, openalex_id, name, created_at, checked_at, data) "
                     f"VALUES ({_PH}, {_PH}, {_PH}, {_PH}, {_PH}, {_PH}, {_PH}, {_PH})",
                     (fid, user_id, kind, oid, name.strip()[:160], now, None, json.dumps(data)))
    f = {"id": fid, "kind": kind, "openalex_id": oid, "name": name.strip()[:160], "created_at": now,
         "checked_at": None, **data}
    _refresh(f, first=True)
    return f


def _clean_members(members) -> list[dict]:
    out, seen = [], set()
    for m in members or []:
        aid = short_id((m or {}).get("openalex_id", ""))
        if aid.startswith("A") and aid not in seen and (m.get("name") or "").strip():
            seen.add(aid)
            out.append({"openalex_id": aid, "name": m["name"].strip()[:120]})
    return out[:MAX_MEMBERS]


def _clean_url(u: str) -> str:
    u = (u or "").strip()[:300]
    return u if re.match(r"https?://", u, re.I) else (f"https://{u}" if u and "." in u and " " not in u else "")


def save_group(user_id: str, name: str, website: str, institution: dict | None, members: list[dict],
               fid: str | None = None) -> dict:
    """Create (or, with fid, update) a lab defined by its members."""
    name = (name or "").strip()[:160]
    mem = _clean_members(members)
    if not name:
        raise ValueError("Give the lab a name.")
    if not mem:
        raise ValueError("Add at least one member -- the lab's papers are its members' papers.")
    inst = institution or {}
    inst = {"openalex_id": short_id(inst.get("openalex_id", "")), "name": (inst.get("name") or "").strip()[:160]}
    sub = " · ".join(filter(None, [inst["name"], f"{len(mem)} member{'s' if len(mem) != 1 else ''}"]))
    if fid:
        f = next((x for x in list_follows(user_id) if x["id"] == fid and x["kind"] == "group"), None)
        if not f:
            raise ValueError("That lab is no longer in your list.")
        f.update({"subtitle": sub, "institution": inst, "members": mem, "website": _clean_url(website)})
        with _conn() as conn:
            conn.execute(f"UPDATE watch_follows SET name = {_PH} WHERE id = {_PH} AND user_id = {_PH}",
                         (name, fid, user_id))
        f["name"] = name
        return _refresh(f)          # new members' existing papers will show as New: that's fine
    if len(list_follows(user_id)) >= MAX_FOLLOWS:
        raise ValueError(f"You can watch up to {MAX_FOLLOWS} scholars and laboratories.")
    fid, now = str(uuid.uuid4()), _now()
    data = {"subtitle": sub, "keywords": [], "scope": "", "works": [], "seen": [], "error": None,
            "institution": inst, "members": mem, "website": _clean_url(website)}
    with _conn() as conn:
        conn.execute(f"INSERT INTO watch_follows (id, user_id, kind, openalex_id, name, created_at, checked_at, data) "
                     f"VALUES ({_PH}, {_PH}, {_PH}, {_PH}, {_PH}, {_PH}, {_PH}, {_PH})",
                     (fid, user_id, "group", inst["openalex_id"], name, now, None, json.dumps(data)))
    f = {"id": fid, "kind": "group", "openalex_id": inst["openalex_id"], "name": name, "created_at": now,
         "checked_at": None, **data}
    return _refresh(f, first=True)


def remove_follow(user_id: str, fid: str) -> bool:
    with _conn() as conn:
        cur = conn.execute(f"DELETE FROM watch_follows WHERE id = {_PH} AND user_id = {_PH}", (fid, user_id))
    return bool(getattr(cur, "rowcount", 1))


def _refresh(f: dict, first: bool = False) -> dict:
    try:
        f["works"] = recent_works(f["kind"], f["openalex_id"], f.get("keywords"), f.get("members"))
        f["error"] = None
    except Exception:  # noqa: BLE001 -- OpenAlex unreachable: keep the last list
        f["error"] = "Couldn't reach OpenAlex just now."
    if first:   # what is already out when you follow someone is not "new"
        f["seen"] = [w["id"] for w in f.get("works") or []]
    f["checked_at"] = _now()
    _save(f)
    return f


def _stale(f: dict) -> bool:
    try:
        return datetime.now(timezone.utc) - datetime.fromisoformat(f["checked_at"]) > timedelta(hours=CHECK_HOURS)
    except Exception:  # noqa: BLE001
        return True


def watchlist(user_id: str, refresh: bool = False) -> dict:
    follows = list_follows(user_id)
    due = [f for f in follows if refresh or _stale(f)]
    if due:
        with ThreadPoolExecutor(max_workers=6) as pool:
            list(pool.map(_refresh, due))
    total = 0
    for f in follows:
        seen = set(f.get("seen") or [])
        for w in f.get("works") or []:
            w["new"] = w["id"] not in seen
        f["new_count"] = sum(1 for w in f.get("works") or [] if w["new"])
        total += f["new_count"]
        f.pop("seen", None)
    return {"follows": follows, "new_total": total}


def mark_seen(user_id: str, fid: str | None = None) -> None:
    for f in list_follows(user_id):
        if fid and f["id"] != fid:
            continue
        f["seen"] = sorted(set(f.get("seen") or []) | {w["id"] for w in f.get("works") or []})[-300:]
        _save(f)


# ── a lab from its website ──────────────────────────────────────────────────
# Most labs are not OpenAlex institutions, but their website says what they
# are called, which university hosts them, and who is in them. Read that, then
# keep only what OpenAlex can confirm: the university (its homepage domain must
# match the site's) and members (authors at that university with that name).
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse

_MAX_PAGE = 1_500_000
_TEAM_RE = re.compile(r"\b(team|people|members?|personnel|group|faculty|students|our[-_ ]?lab|lab[-_ ]?members)\b", re.I)
_LABWORD = re.compile(r"\b(lab|labs|laboratory|laboratories|center|centre|group|institute)\b", re.I)
_NAME_RE = re.compile(r"^(?:(?:Dr|Prof|Professor|Mr|Ms|Mrs)\.?\s+)?"
                      r"((?:[A-Z][a-zA-Z'À-ſ\-]+|[A-Z]\.)(?:\s+(?:[A-Z][a-zA-Z'À-ſ\-]+|[A-Z]\.)){1,3})"
                      r"(?:,?\s*(?:Ph\.?D\.?|P\.?E\.?|IEEE Fellow|Fellow))?$")
_NOT_NAME = set("""home about research team people members news publications contact projects facilities
lab laboratory center university department school college engineering science sciences technology
students alumni faculty staff director graduate undergraduate postdoctoral visiting scholars join us our
read more the and of for in at dallas texas electrical computer mechanical energy vehicle vehicular renewable
power systems professor associate assistant research scientist""".split())


class _Page(HTMLParser):
    """Collects the title, headings, short text blocks and links of a page."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.title, self.h1, self.site = "", [], ""
        self.texts, self.links = [], []
        self._stack, self._href, self._buf = [], None, []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "meta" and (a.get("property") == "og:site_name") and a.get("content"):
            self.site = a["content"].strip()
        if tag in ("script", "style", "noscript", "svg"):
            self._stack.append(tag)
        if tag == "a":
            self._href, self._buf = a.get("href"), []
        if tag in ("title", "h1", "h2", "h3", "h4", "h5", "strong", "b", "p", "li", "td", "span", "div", "figcaption"):
            self.texts.append([tag, ""])

    def handle_endtag(self, tag):
        if self._stack and self._stack[-1] == tag:
            self._stack.pop()
        if tag == "a" and self._href is not None:
            self.links.append((self._href, " ".join("".join(self._buf).split())))
            self._href = None

    def handle_data(self, data):
        if self._stack:
            return
        if self._href is not None:
            self._buf.append(data)
        if self.texts:
            tag = self.texts[-1][0]
            self.texts[-1][1] += data
            if tag == "title":
                self.title += data
            elif tag == "h1":
                self.h1.append(data)


def _fetch(url: str, client: httpx.Client) -> tuple[str, str]:
    """GET a public web page, following up to 4 redirects, each one checked."""
    from core.paper_text import _is_safe_url
    for _ in range(5):
        if not _is_safe_url(url):
            raise ValueError("That address can't be opened.")
        r = client.get(url)
        if r.is_redirect and r.headers.get("location"):
            url = urljoin(url, r.headers["location"])
            continue
        r.raise_for_status()
        if "html" not in (r.headers.get("content-type") or "html"):
            raise ValueError("That link isn't a web page.")
        return url, r.text[:_MAX_PAGE]
    raise ValueError("Too many redirects.")


def _parse(html: str) -> _Page:
    p = _Page()
    try:
        p.feed(html)
    except Exception:  # noqa: BLE001 -- broken markup: keep what was read
        pass
    return p


def _reg_domain(host: str) -> str:
    parts = (host or "").lower().split(".")
    if parts and parts[0] == "www":
        parts = parts[1:]
    if len(parts) >= 3 and parts[-2] in ("ac", "edu", "co", "org", "gov") and len(parts[-1]) == 2:
        return ".".join(parts[-3:])
    return ".".join(parts[-2:])


def _segments(*texts: str) -> list[str]:
    out = []
    for t in texts:
        for seg in re.split(r"\s+[|–—\-:·]\s+|\s*\|\s*", " ".join((t or "").split())):
            seg = seg.strip(" -|")
            if 3 <= len(seg) <= 140 and seg not in out:
                out.append(seg)
    return out


def _find_institution(client: httpx.Client, site: str, candidates: list[str]) -> dict | None:
    """The OpenAlex institution whose homepage is on the same domain as the lab's site."""
    want = _reg_domain(urlparse(site).hostname or "")
    for q in candidates[:6]:
        try:
            r = client.get(f"{API}/institutions", params={"search": q, "per_page": 5, "mailto": _mailto()})
            r.raise_for_status()
        except Exception:  # noqa: BLE001
            continue
        for x in r.json().get("results") or []:
            home = _reg_domain(urlparse(x.get("homepage_url") or "").hostname or "")
            if home and home == want:
                return {"openalex_id": short_id(x.get("id", "")), "name": x.get("display_name") or q}
    return None


def _names(page: _Page) -> list[str]:
    out = []
    for tag, txt in page.texts + [["a", t] for _, t in page.links]:
        t = " ".join((txt or "").split()).strip(" ,;:")
        if not (5 <= len(t) <= 60):
            continue
        m = _NAME_RE.match(t)
        if not m:
            continue
        name = m.group(1)
        words = [w.strip(".").lower() for w in name.split()]
        if any(w in _NOT_NAME for w in words) or name in out:
            continue
        out.append(name)
    return out[:60]


def _same_person(a: str, b: str) -> bool:
    ta = [w.strip(".").lower() for w in re.split(r"[\s\-]+", a) if w.strip(".")]
    tb = [w.strip(".").lower() for w in re.split(r"[\s\-]+", b) if w.strip(".")]
    if not ta or not tb or ta[-1] != tb[-1]:
        return False                                  # surnames must agree
    return ta[0][0] == tb[0][0]                       # and the first initial


def _match_member(name: str, inst: str) -> dict | None:
    try:
        rows = search("scholar", name, inst)
    except Exception:  # noqa: BLE001
        return None
    for r in rows:
        if _same_person(name, r["name"]):
            return {"openalex_id": r["openalex_id"], "name": r["name"], "subtitle": r["subtitle"],
                    "works_count": r["works_count"], "listed_as": name}
    return None


def lab_from_url(url: str) -> dict:
    """Read a lab's website: name, host university, and members OpenAlex knows."""
    url = (url or "").strip()
    if not re.match(r"https?://", url, re.I):
        url = "https://" + url
    with httpx.Client(timeout=15, headers={**UA, "Accept": "text/html"}, follow_redirects=False) as c:
        final, html = _fetch(url, c)
        page = _parse(html)
        segs = _segments(page.title, " ".join(page.h1), page.site)
        name = next((s for s in segs if _LABWORD.search(s)), segs[0] if segs else "")
        # university: other title parts, the site name, and any "University of ..." on the page
        body = " ".join(t for _, t in page.texts)
        unis = re.findall(r"(?:The\s+)?(?:University of [A-Z][\w&\-]+(?: (?:at|of|in) [A-Z][\w\-]+)*(?: [A-Z][\w\-]+)?"
                          r"|[A-Z][\w\-]+(?: [A-Z][\w\-]+)* (?:University|Institute of Technology))", body)
        cands = [s for s in segs if s != name] + sorted(set(unis), key=lambda u: -body.count(u))
        inst = _find_institution(c, final, cands)
        # team page: the lab site's own link that looks like "Team" / "People"
        host = urlparse(final).hostname
        team_url, team_page = None, page
        for href, text in page.links:
            if not href or href.startswith(("mailto:", "#", "javascript:")):
                continue
            full = urljoin(final, href)
            if urlparse(full).hostname == host and (_TEAM_RE.search(text or "") or _TEAM_RE.search(urlparse(full).path)):
                team_url = full
                break
        if team_url and team_url.rstrip("/") != final.rstrip("/"):
            try:
                team_url, html2 = _fetch(team_url, c)
                team_page = _parse(html2)
            except Exception:  # noqa: BLE001 -- fall back to names on the first page
                team_url = None
    listed = _names(team_page) or _names(page)
    members, unmatched = [], []
    if inst and listed:
        with ThreadPoolExecutor(max_workers=6) as pool:
            for n, m in zip(listed[:30], pool.map(lambda n: _match_member(n, inst["openalex_id"]), listed[:30])):
                if m and all(x["openalex_id"] != m["openalex_id"] for x in members):
                    members.append(m)
                elif not m:
                    unmatched.append(n)
    return {"name": name[:160], "website": final, "institution": inst, "team_page": team_url,
            "members": members, "unmatched": unmatched[:30], "names_found": len(listed)}
