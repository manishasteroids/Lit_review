# Changes intentionally EXCLUDED from the token-calculation PR

These were built during the same session but pulled OUT of the token-usage PR to
keep it focused. Bring them back in follow-up PRs. Nothing here is committed to
the token branch.

---

## 1. Session rehydration fix  (backend/api/routes.py)

Fixes the "Run not found" error when you restore an old session from History and
then continue a stage (the in-memory `RUNS` dict is lost on backend restart).
Rebuilds the run from the persisted SQLite session.

**To re-apply:** in `backend/api/routes.py`

Change the import back to include `RunState`:

```python
from pipeline.orchestrator import RUNS, RunState, SamhitaPipeline
```

Add this function and point `get_run` at it:

```python
def _rehydrate_run(run_id: str):
    """Rebuild an in-memory RunState from the saved SQLite session.

    Run state lives in the in-memory RUNS dict, which is lost on a backend
    restart. When the user restores an old session from History and then
    continues a stage, the run is gone from memory — so we reconstruct it
    from the persisted session data instead of 404-ing.
    """
    s = get_session(run_id)
    if not s:
        return None
    d = s.get("data") or {}
    run = RunState(run_id=run_id, topic=d.get("topic", ""))
    run.reform = d.get("reform")
    run.papers = d.get("papers", []) or []
    # `approved` is a {idx: bool} map; JSON turns int keys into strings.
    ap = d.get("approved", {}) or {}
    def _is_approved(idx):
        return bool(ap.get(idx, ap.get(str(idx), False)))
    run.approved_papers = [p for p in run.papers if _is_approved(p.get("idx"))]
    run.extractions = d.get("extractions", []) or []
    run.synthesis = d.get("synth")
    run.sections = d.get("sections", {}) or {}
    run.stage = s.get("stage", "filter")
    RUNS[run_id] = run  # cache so subsequent stage calls hit memory
    return run


def get_run(run_id: str):
    run = RUNS.get(run_id) or _rehydrate_run(run_id)
    if not run:
        raise HTTPException(404, "Run not found. Start a new run from the topic screen.")
    return run
```

---

## 2. Stage tests + inspect scripts  (backend/tests/)

Standalone files, already on disk — just don't `git add` them to the token PR:

- `backend/tests/conftest.py`
- `backend/tests/test_query_reformulator.py`
- `backend/tests/inspect_reformulator.py`
- `backend/tests/test_academic_search.py`
- `backend/tests/inspect_academic_search.py`

---

## 3. Architecture / design docs (repo root)

- `ARCHITECTURE_REPORT.md`
- `NEAR_TERM_DESIGN.md`
- `Samhita_Architecture_Report.docx`
- `Samhita_Near-term_Feature_Design.docx`

---

## 4. .gitignore additions

Optional hygiene lines added this session (`.pytest_cache/`, `_v*.jpg`, `_nd*.jpg`,
`*.db`). Left OUT of the token PR — just don't `git add .gitignore`.
