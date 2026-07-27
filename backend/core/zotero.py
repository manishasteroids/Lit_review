"""
Zotero import — read-only pull of a user's Zotero library into a project's
paper list, via Zotero's public Web API (api.zotero.org). No LLM involved.

Users generate a read-only API key at https://www.zotero.org/settings/keys
and find their library id (their numeric userID for a personal library, or a
group id for a shared library) on the same page. We never store the key —
it's passed per-request and used once.
"""
from typing import Optional

import httpx

BASE = "https://api.zotero.org"
UA = {"User-Agent": "Samhita-LitReview/1.0 (research assistant; Zotero import)"}
PAGE_SIZE = 100
MAX_ITEMS = 500  # hard cap per import so one click can't pull an entire huge library


def _authors(creators: list[dict]) -> str:
    names = []
    for c in creators or []:
        if c.get("name"):
            names.append(c["name"])
        else:
            n = " ".join(x for x in [c.get("firstName"), c.get("lastName")] if x)
            if n:
                names.append(n)
    if not names:
        return ""
    if len(names) == 1:
        return names[0]
    return f"{names[0]} et al."


def _to_paper(item: dict) -> Optional[dict]:
    data = item.get("data") or {}
    itype = data.get("itemType")
    if itype in ("attachment", "note"):
        return None
    title = (data.get("title") or "").strip()
    if not title:
        return None
    url = data.get("url") or ""
    if not url and data.get("DOI"):
        url = f"https://doi.org/{data['DOI']}"
    date = data.get("date") or ""
    year = None
    for tok in date.replace("-", " ").split():
        if tok.isdigit() and len(tok) == 4:
            year = int(tok)
            break
    return {
        "title": title,
        "authors": _authors(data.get("creators")),
        "year": year,
        "venue": data.get("publicationTitle") or data.get("proceedingsTitle") or data.get("bookTitle") or "",
        "url": url,
        "abstract": data.get("abstractNote") or "",
        "zotero_key": data.get("key"),
    }


def fetch_library_items(api_key: str, library_id: str, library_type: str = "user") -> list[dict]:
    """Fetch up to MAX_ITEMS top-level items from a Zotero personal ("user") or
    group library, converted to Samhita's paper shape. Raises on auth/network
    failure so the route can surface a clear error."""
    kind = "groups" if library_type == "group" else "users"
    headers = {**UA, "Zotero-API-Key": api_key, "Zotero-API-Version": "3"}
    papers: list[dict] = []
    start = 0
    with httpx.Client(timeout=20.0, headers=headers) as client:
        while len(papers) < MAX_ITEMS:
            resp = client.get(
                f"{BASE}/{kind}/{library_id}/items/top",
                params={"limit": PAGE_SIZE, "start": start, "format": "json"},
            )
            if resp.status_code == 403:
                raise ValueError("Zotero rejected the API key — check the key and library id.")
            if resp.status_code == 404:
                raise ValueError("Zotero library not found — check the library id and type.")
            resp.raise_for_status()
            batch = resp.json()
            if not batch:
                break
            for item in batch:
                p = _to_paper(item)
                if p:
                    papers.append(p)
            if len(batch) < PAGE_SIZE:
                break
            start += PAGE_SIZE
    return papers[:MAX_ITEMS]
