"""
Knowledge Graph
----------------
Diagram side module: "Built from extracted papers"

Builds a small concept <-> paper graph from the Reader & Extractor's concept
tags. Swap this for a Neo4j-backed version if you want it to persist and
grow across runs instead of being rebuilt per-review.

Also home to `find_bridge_candidates()` — the graph is not just a display
widget: it's mined for concept pairs that look like a genuine structural gap
(see its docstring) and that signal is fed into the Experiment Designer, not
just shown on the side. Both functions share one concept index so a run's
concept tags are only parsed once.

Near-duplicate concept labels (fixed): the Reader & Extractor tags concepts
freely per paper, so the same idea often shows up under different phrasings
across papers -- "LLMs" in one, "Large Language Models" in another, "LLM" in
a third. Left unmerged, each phrasing became its own graph node: co-occurrence
counts split across synonyms (weakening real signal), and worse, two labels
for the SAME idea could themselves surface as a "bridge candidate" -- a
nonsensical suggestion to connect a concept to itself under a different name.
`_merge_near_duplicates()` below folds these together (exact match after
normalizing, singular/plural, and acronym expansion in either direction, plus
a high-similarity fallback for near-identical phrasing) before either
function uses the concept index, so the fix applies everywhere concepts are
used, not just at display time.
"""
import re
from collections import defaultdict
from difflib import SequenceMatcher


def _concept_index(extractions: list[dict]) -> dict:
    """concept key (lowercased) -> {"label": original casing, "papers": {idx,...}}.
    Exact-match dedup only (case/whitespace) -- near-duplicate PHRASINGS
    ("LLMs" vs "Large Language Models") are a separate pass, see
    `_merge_near_duplicates` below, since that needs to compare across keys
    rather than within one."""
    idx: dict = defaultdict(lambda: {"label": "", "papers": set()})
    for e in extractions:
        pid = e.get("idx")
        if pid is None:
            continue
        for c in e.get("concepts", []) or []:
            key = c.strip().lower()
            if not key:
                continue
            idx[key]["label"] = c.strip()
            idx[key]["papers"].add(pid)
    return idx


def _normalize(label: str) -> str:
    """Lowercase, strip punctuation, collapse whitespace -- the base form
    every near-duplicate comparison below starts from."""
    s = label.lower().strip()
    s = re.sub(r"[^\w\s]", "", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def _singular(s: str) -> str:
    """Crude plural fold ("models" -> "model") for COMPARISON only, not
    display -- a false fold here just means one merge decision is generous,
    never a garbled label, since the canonical label is always chosen from
    the original inputs (see `_merge_near_duplicates`)."""
    return s[:-1] if s.endswith("s") and len(s) > 3 else s


def _acronym_of(label: str) -> str:
    """First-letter acronym of a multi-word label, e.g. "large language
    models" -> "llms" (keeps a trailing plural s so it lines up with an
    already-pluralized acronym like "LLMs", not just "LLM")."""
    words = _normalize(label).split()
    if len(words) < 2:
        return ""
    acro = "".join(w[0] for w in words if w)
    if words[-1].endswith("s") and not acro.endswith("s"):
        acro += "s"
    return acro


def _same_concept(label_a: str, label_b: str) -> bool:
    """True when two concept labels almost certainly name the same idea.
    Checked cheapest-first: exact normalized match, singular/plural fold,
    acronym match in either direction (handles "LLM"/"LLMs" <-> "Large
    Language Model(s)"), then a high-similarity fallback (>=0.92 ratio) for
    near-identical phrasing a typo or minor wording difference wouldn't
    otherwise catch. Deliberately conservative -- an unmerged near-duplicate
    just means two graph nodes instead of one (the old behavior); a false
    MERGE would silently conflate two different concepts, which is worse."""
    na, nb = _normalize(label_a), _normalize(label_b)
    if not na or not nb:
        return False
    if na == nb:
        return True
    if _singular(na) == _singular(nb):
        return True
    tight_a, tight_b = na.replace(" ", ""), nb.replace(" ", "")
    if _acronym_of(label_a) and _acronym_of(label_a) == tight_b:
        return True
    if _acronym_of(label_b) and _acronym_of(label_b) == tight_a:
        return True
    if SequenceMatcher(None, na, nb).ratio() >= 0.92:
        return True
    return False


class _UnionFind:
    """Minimal union-find over a fixed set of keys -- just enough to cluster
    near-duplicate concept labels into groups; no need for a real graph lib
    over what's at most a few dozen concept tags per run."""

    def __init__(self, items):
        self.parent = {x: x for x in items}

    def find(self, x):
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[ra] = rb


def _merge_near_duplicates(idx: dict) -> dict:
    """Collapse near-duplicate concept labels (see module docstring) into one
    node per cluster. Canonical label = whichever original phrasing has the
    most paper support in this run (ties broken by the longer label, since a
    spelled-out form is generally more informative to read than a bare
    acronym) -- picked from the ACTUAL labels seen, never synthesized, so the
    result is always something a paper really used. O(n^2) pairwise compares
    over `idx`'s keys, which is fine at the scale of concept tags per run
    (dozens, not thousands)."""
    keys = list(idx.keys())
    uf = _UnionFind(keys)
    for i, a in enumerate(keys):
        for b in keys[i + 1:]:
            if _same_concept(idx[a]["label"], idx[b]["label"]):
                uf.union(a, b)

    clusters: dict = defaultdict(list)
    for k in keys:
        clusters[uf.find(k)].append(k)

    merged: dict = {}
    for root, members in clusters.items():
        best = max(members, key=lambda k: (len(idx[k]["papers"]), len(idx[k]["label"])))
        papers: set = set()
        for m in members:
            papers |= idx[m]["papers"]
        merged[root] = {"label": idx[best]["label"], "papers": papers}
    return merged


def _neighbors(concept_index: dict) -> dict:
    """concept key -> set of OTHER concept keys that co-occur with it in at
    least one paper (i.e. some paper's Reader & Extractor concept list tagged
    both)."""
    paper_to_concepts: dict = defaultdict(set)
    for key, info in concept_index.items():
        for pid in info["papers"]:
            paper_to_concepts[pid].add(key)
    neigh: dict = defaultdict(set)
    for keys in paper_to_concepts.values():
        for k in keys:
            neigh[k] |= (keys - {k})
    return neigh


def build_knowledge_graph(extractions: list[dict], top_n: int = 18) -> list[dict]:
    concept_map = _merge_near_duplicates(_concept_index(extractions))
    concepts = sorted(concept_map.values(), key=lambda c: -len(c["papers"]))
    return [{"label": c["label"], "papers": sorted(c["papers"])} for c in concepts[:top_n]]


def find_bridge_candidates(extractions: list[dict], min_support: int = 2,
                            max_candidates: int = 6) -> list[dict]:
    """Literature-based-discovery ("Swanson ABC linking") over this run's own
    concept graph: find concept pairs A / C that never co-occur in any single
    paper here, but each separately co-occurs with some shared concept B in a
    *different* paper — A - B - C forms a path with no direct A - C edge.
    That's a structural candidate for a connection the corpus never states in
    words, which is a stronger, more specific novelty signal than a
    text-synthesized "gap": it points at a concrete pair of concepts nobody
    in this corpus has combined, plus the paper(s) that make each half
    plausible on its own.

    Runs over the near-duplicate-merged concept index (see
    `_merge_near_duplicates`), not the raw one -- without that merge, two
    labels for the same idea ("LLMs" / "Large Language Models") could
    themselves come back as a "bridge candidate", which is nonsense (there's
    no real gap between a concept and itself under a different name), and
    real bridges were weakened by co-occurrence counts splitting across
    synonyms instead of accumulating on one node.

    `min_support` requires each side to appear in >=2 papers so a single
    paper's one-off tag doesn't produce noise. Returns at most
    `max_candidates`, ranked by how many distinct bridging concepts connect
    the pair (more independent paths = a more robust candidate, not an
    artifact of one paper's phrasing).
    """
    idx = _merge_near_duplicates(_concept_index(extractions))
    keys = [k for k, v in idx.items() if len(v["papers"]) >= min_support]
    neigh = _neighbors(idx)

    candidates = []
    for i, a in enumerate(keys):
        for c in keys[i + 1:]:
            if idx[a]["papers"] & idx[c]["papers"]:
                continue  # already co-occur directly — not a novel bridge
            bridge_keys = (neigh[a] & neigh[c]) - {a, c}
            if not bridge_keys:
                continue
            candidates.append({
                "a": idx[a]["label"],
                "c": idx[c]["label"],
                "a_papers": sorted(idx[a]["papers"]),
                "c_papers": sorted(idx[c]["papers"]),
                "bridges": sorted({idx[b]["label"] for b in bridge_keys}),
                "strength": len(bridge_keys),
            })
    candidates.sort(key=lambda x: -x["strength"])
    return candidates[:max_candidates]
