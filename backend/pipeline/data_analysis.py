"""
Data Analysis
--------------
Diagram side module: "Compare papers, plots, tables, visualizations"
"""
from collections import Counter


def year_distribution(papers: list[dict]) -> list[dict]:
    counts = Counter(str(p.get("year", "n/a")) for p in papers)
    return [{"year": y, "count": c} for y, c in sorted(counts.items())]


def comparison_table(
    papers: list[dict], extractions_by_idx: dict[int, dict], ranked_by_idx: dict[int, dict]
) -> list[dict]:
    rows = []
    for p in papers:
        e = extractions_by_idx.get(p["idx"], {})
        r = ranked_by_idx.get(p["idx"], {})
        rows.append(
            {
                "idx": p["idx"],
                "title": p["title"],
                "year": p.get("year"),
                "method": e.get("method"),
                "finding": e.get("finding"),
                "score": r.get("score"),
            }
        )
    return rows
