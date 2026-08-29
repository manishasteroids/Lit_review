"""
Hypothesis Agent -- Phase 0 standalone runner
==============================================
Bootstraps the Hypothesis Agent by reusing Sift's existing agents directly
(ExperimentDesignerAgent, HypothesisCriticAgent, find_bridge_candidates),
run completely outside Sift's own orchestrator/run lifecycle. This is a
deliberate, temporary shortcut (see hypothesis_agent_architecture.md SS1.1)
-- same codebase, no separate service yet -- to get something testable
fast. Extracting this into its own service (SS1.2) is a later phase in the
implementation plan, not this one.

Usage
-----
Run against a real Sift session already sitting in your local sift.db:

    python standalone_run.py --session-id <run_id> [--user-id <user_id>]

Run against a hand-built Literature Package snapshot -- no DB needed, good
for a quick dry run, or once a real export endpoint exists:

    python standalone_run.py --from-json sample_literature_package.json

Either way you need ANTHROPIC_API_KEY (or GEMINI_API_KEY) set -- backend/.env
is loaded automatically if present, via Sift's own core.config. This makes
real, billed LLM calls.

Output
------
Prints a readable summary to stdout, and writes the full JSON (topic, bridge
candidates, plan, critique, and run metadata) to
hypothesis_agent/runs/<timestamp>-<slug>.json -- the first cut of the
audit-artifact idea (architecture doc SS6.4): a durable trace of exactly
what went into and came out of a run, independent of Sift's own database.
"""
import argparse
import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

HYP_AGENT_DIR = Path(__file__).resolve().parent
BACKEND_DIR = HYP_AGENT_DIR.parent / "backend"
RUNS_DIR = HYP_AGENT_DIR / "runs"

# Sift's agents/core modules use bare imports (`from agents.base import
# Agent`, `from core.llm_client import LLMClient`) that assume backend/ is
# the sys.path root -- exactly as it is when Sift's own FastAPI app runs
# from inside backend/. Add it here so this script can import the same
# code, unmodified, from outside that app.
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))


def _slugify(text: str, max_len: int = 40) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (text or "run").lower()).strip("-")
    return (s or "run")[:max_len]


def load_from_session(session_id: str, user_id: Optional[str]) -> dict:
    """Pull a Literature Package snapshot straight from Sift's own DB --
    this is exactly the data a future GET /runs/{id}/export would return
    (architecture doc SS1.2); reading it directly is a stand-in for that
    endpoint, which doesn't exist yet."""
    from core.db import _conn, _PH, get_session

    if user_id:
        row = get_session(session_id, user_id)
        if not row:
            raise SystemExit(
                f"No session '{session_id}' found for user '{user_id}'. "
                "Check the id, or omit --user-id to look it up by id alone."
            )
        data = row["data"]
        topic = row.get("topic") or data.get("topic", "")
    else:
        # Personal local tool, local db you own -- skip the ownership check
        # get_session() enforces, and just read the row directly by id.
        with _conn() as conn:
            found = conn.execute(
                f"SELECT * FROM sessions WHERE id = {_PH}", (session_id,),
            ).fetchone()
        if not found:
            raise SystemExit(f"No session '{session_id}' found in the local DB.")
        row = dict(found)
        data = json.loads(row["data"])
        topic = row.get("topic") or data.get("topic", "")

    extractions = data.get("extractions") or []
    synth = data.get("synth")
    if not extractions:
        raise SystemExit(
            f"Session '{session_id}' has no extractions yet -- run it "
            "through Sift's Reader & Extractor stage first."
        )
    return {
        "topic": topic,
        "extractions": extractions,
        "synth": synth,
        "source": f"session:{session_id}",
    }


def load_from_json(path: str) -> dict:
    data = json.loads(Path(path).read_text())
    if "topic" not in data or "extractions" not in data:
        raise SystemExit(f"{path} must contain at least 'topic' and 'extractions'.")
    data.setdefault("synth", data.get("synthesis"))
    data["source"] = f"json:{path}"
    return data


def run_pipeline(package: dict, model: Optional[str] = None) -> dict:
    """The Phase 0 pipeline: bridge lookup -> Generation -> Critique.
    Deliberately just these two agents, at today's cap -- the best-outcome
    pipeline (ranking bracket, meta-review, raised cap) is a later phase,
    not part of proving this reused-code path works at all."""
    from agents.experiment_designer import ExperimentDesignerAgent
    from agents.hypothesis_critic import HypothesisCriticAgent
    from core.config import settings
    from core.llm_client import LLMClient
    from pipeline.knowledge_graph import find_bridge_candidates

    if not settings.anthropic_api_key and not settings.gemini_api_key:
        raise SystemExit(
            "No ANTHROPIC_API_KEY or GEMINI_API_KEY found. Set one in "
            "backend/.env or the environment before running this."
        )

    topic = package["topic"]
    extractions = package["extractions"]
    synthesis = package.get("synth") or {}

    run_id = f"hyp-standalone-{int(time.time())}"
    llm = LLMClient(
        model=model or settings.mid_model or settings.model,
        run_id=run_id,
        stage="hypothesis_standalone",
    )

    bridges = find_bridge_candidates(extractions)

    designer = ExperimentDesignerAgent(llm)
    plan = designer.run(topic, synthesis, extractions, kg_bridges=bridges)

    critic = HypothesisCriticAgent(llm)
    critique = critic.run(topic, plan, extractions)

    return {
        "run_id": run_id,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "model": llm.model,
        "source": package.get("source"),
        "topic": topic,
        "kg_bridges": bridges,
        "plan": plan,
        "critique": critique,
    }


def print_summary(result: dict) -> None:
    plan = result["plan"]
    critique = result["critique"]
    crit_by_idx = {c.get("index"): c for c in critique.get("critiques", [])}

    print(f"\n=== Hypothesis Agent -- standalone run {result['run_id']} ===")
    print(f"model: {result['model']}   source: {result['source']}")
    print(f"topic: {result['topic']}")
    print(f"domain (inferred): {plan.get('domain', '?')}")

    bridges = result["kg_bridges"]
    if bridges:
        print(f"\nbridge candidates found: {len(bridges)}")
        for b in bridges[:3]:
            bridge_names = "/".join(b["bridges"])
            print(f"  - {b['a']}  <-{bridge_names}->  {b['c']}  (strength {b['strength']})")
    else:
        print("\nbridge candidates found: 0")

    hyps = plan.get("hypotheses", [])
    print(f"\n{len(hyps)} hypothesis(es):")
    for i, h in enumerate(hyps):
        c = crit_by_idx.get(i, {})
        scores = c.get("scores", {})
        print(f"\n[{i}] {h.get('hypothesis', '(missing)')}")
        print(f"    rationale: {h.get('rationale', '')}")
        if scores:
            print(
                f"    scores: novelty={scores.get('novelty')} "
                f"grounding={scores.get('grounding')} "
                f"testability={scores.get('testability')} "
                f"consistency={scores.get('consistency')}  "
                f"overall={c.get('overall')}"
            )
        if c.get("issues"):
            print(f"    issues: {'; '.join(c['issues'])}")
        if c.get("revise"):
            print(f"    revise: {c['revise']}")

    if plan.get("note"):
        print(f"\ndesigner note: {plan['note']}")
    if critique.get("note"):
        print(f"critic note: {critique['note']}")


def save_run(result: dict) -> Path:
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_path = RUNS_DIR / f"{stamp}-{_slugify(result['topic'])}.json"
    out_path.write_text(json.dumps(result, indent=2))
    return out_path


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Phase 0: run the Hypothesis Agent standalone, reusing Sift's "
            "existing Generation + Critique agents directly."
        ),
    )
    src = parser.add_mutually_exclusive_group(required=True)
    src.add_argument(
        "--session-id", help="An existing Sift run id (reads its local sift.db row)."
    )
    src.add_argument(
        "--from-json", help="A Literature Package JSON file (topic + extractions [+ synth])."
    )
    parser.add_argument(
        "--user-id",
        help="Owner of --session-id, if your DB enforces it. Omit for a personal local db.",
    )
    parser.add_argument(
        "--model", help="Override the model (defaults to Sift's configured mid_model)."
    )
    args = parser.parse_args()

    if args.session_id:
        package = load_from_session(args.session_id, args.user_id)
    else:
        package = load_from_json(args.from_json)

    result = run_pipeline(package, model=args.model)
    print_summary(result)
    out_path = save_run(result)
    print(f"\nfull run saved to: {out_path}")


if __name__ == "__main__":
    main()
