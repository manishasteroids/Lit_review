"""
Knowledge Graph
----------------
Diagram side module: "Built from extracted papers"

Builds a small concept <-> paper graph from the Reader & Extractor's concept
tags. Swap this for a Neo4j-backed version if you want it to persist and
grow across runs instead of being rebuilt per-review.
"""
from collections import defaultdict


def build_knowledge_graph(extractions: list[dict], top_n: int = 8) -> list[dict]:
    concept_map: dict[str, dict] = defaultdict(lambda: {"label": "", "papers": []})
    for e in extractions:
        for c in e.get("concepts", []):
            key = c.strip().lower()
            concept_map[key]["label"] = c.strip()
            concept_map[key]["papers"].append(e["idx"])
    concepts = sorted(concept_map.values(), key=lambda c: -len(c["papers"]))
    return concepts[:top_n]
