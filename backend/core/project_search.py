"""
Search a user's OWN projects/notes/runs for text matching a question --
the "Search my projects" option on the Home page's quick-ask box.

The first version of this matched the ENTIRE question as one LIKE '%...%'
substring, which meant "find my protein translation project" never matched
a project literally named "Protein Translation" (the substring
"find my protein translation project" doesn't occur in "Protein
Translation"). Fixed here by tokenizing the question into significant
words, matching each token independently, and ranking candidates by how
many distinct tokens they matched -- still plain SQL/Python string
matching, no embeddings/FTS index, but robust to the question being phrased
as a sentence instead of a bare keyword. Good enough for the volume of
projects/runs/notes one user has; upgrade to FTS5 / embeddings later if
search quality becomes the limiting factor rather than the LLM's ability to
use the matched text.
"""
import re
from typing import Optional

from core.db import _conn, _PH

# Small, deliberately generic stopword list -- words that carry no search
# signal in a question like "can you find my protein translation project".
# Not linguistically exhaustive; just enough to strip the scaffolding words
# that show up in how people actually phrase these questions.
_STOPWORDS = {
    "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
    "i", "me", "my", "we", "us", "our", "you", "your", "it", "its",
    "this", "that", "these", "those",
    "find", "search", "show", "get", "give", "tell", "look", "looking",
    "please", "can", "could", "would", "should", "do", "does", "did",
    "what", "where", "which", "who", "when", "how", "why",
    "project", "projects", "about", "regarding", "on", "in", "of", "for",
    "to", "with", "from", "by", "and", "or", "any", "some",
}


def _tokenize(query: str) -> list[str]:
    words = re.findall(r"[A-Za-z0-9]+", query.lower())
    tokens = [w for w in words if len(w) >= 3 and w not in _STOPWORDS]
    return tokens or words  # if everything was a stopword, fall back to all words


def _score(text: str, tokens: list[str]) -> int:
    text = (text or "").lower()
    return sum(1 for t in tokens if t in text)


def search_user_projects(user_id: str, query: str, limit: int = 6) -> list[dict]:
    q = (query or "").strip()
    if not q:
        return []
    tokens = _tokenize(q)
    if not tokens:
        return []

    candidates: list[dict] = []

    with _conn() as conn:
        # Projects the user owns or collaborates on.
        rows = conn.execute(
            "SELECT id, name, description FROM projects "
            f"WHERE user_id = {_PH} "
            "UNION "
            "SELECT p.id, p.name, p.description FROM projects p "
            "JOIN project_collaborators c ON c.project_id = p.id "
            f"WHERE c.user_id = {_PH}",
            (user_id, user_id),
        ).fetchall()
        for r in rows:
            r = dict(r)
            blob = f"{r['name'] or ''} {r['description'] or ''}"
            score = _score(blob, tokens)
            if score:
                candidates.append({
                    "type": "project", "project_id": r["id"], "project_name": r["name"],
                    "title": r["name"], "snippet": (r["description"] or "")[:280],
                    "score": score + 1,  # a project's own name/description matching is the strongest signal
                })

        # Literature Review runs filed under an accessible project.
        rows = conn.execute(
            "SELECT s.id AS run_id, s.topic, s.project_id, s.stage, s.updated_at, p.name AS project_name "
            "FROM sessions s JOIN projects p ON p.id = s.project_id "
            f"WHERE s.project_id IS NOT NULL AND "
            f"(p.user_id = {_PH} OR p.id IN "
            f"(SELECT project_id FROM project_collaborators WHERE user_id = {_PH})) "
            "ORDER BY s.updated_at DESC",
            (user_id, user_id),
        ).fetchall()
        for r in rows:
            r = dict(r)
            blob = f"{r['topic'] or ''} {r['project_name'] or ''}"
            score = _score(blob, tokens)
            if score:
                candidates.append({
                    "type": "run", "project_id": r["project_id"], "project_name": r["project_name"],
                    "title": r["topic"], "snippet": f"Literature Review ({r['stage']})",
                    "run_id": r["run_id"], "score": score,
                })

        # Notes on an accessible project.
        rows = conn.execute(
            "SELECT n.project_id, n.title, n.body, p.name AS project_name "
            "FROM project_notes n JOIN projects p ON p.id = n.project_id "
            f"WHERE (p.user_id = {_PH} OR p.id IN "
            f"(SELECT project_id FROM project_collaborators WHERE user_id = {_PH}))",
            (user_id, user_id),
        ).fetchall()
        for r in rows:
            r = dict(r)
            blob = f"{r['title'] or ''} {r['body'] or ''}"
            score = _score(blob, tokens)
            if score:
                candidates.append({
                    "type": "note", "project_id": r["project_id"], "project_name": r["project_name"],
                    "title": r["title"] or "Note", "snippet": (r["body"] or "")[:280],
                    "score": score,
                })

    candidates.sort(key=lambda h: h["score"], reverse=True)
    for h in candidates:
        h.pop("score", None)
    return candidates[:limit]
