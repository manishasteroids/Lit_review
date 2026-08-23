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
"""
from collections import defaultdict


def _concept_index(extractions: list[dict]) -> dict:
    """concept key (lowercased) -> {"label": original casing, "papers": {idx,...}}"""
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
    concept_map = _concept_index(extractions)
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

    `min_support` requires each side to appear in >=2 papers so a single
    paper's one-off tag doesn't produce noise. Returns at most
    `max_candidates`, ranked by how many distinct bridging concepts connect
    the pair (more independent paths = a more robust candidate, not an
    artifact of one paper's phrasing).
    """
    idx = _concept_index(extractions)
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
