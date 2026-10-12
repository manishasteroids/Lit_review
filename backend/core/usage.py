"""
Usage & cost ledger.

Every LLM call is recorded here (one row in `llm_calls`) with its session,
stage, model, token counts, dollar cost and latency.  Aggregation for the
Usage tab is a couple of GROUP BY queries — no LLM needed.

This is deliberately the ONE place cost is computed, so the number the user
sees always matches what actually went over the wire.
"""
from datetime import datetime, timezone
from typing import Optional

from core.db import _conn, _PH, _AUTO_ID, _existing_columns
from core.pricing import cost_usd, tier_of, PRICES_EFFECTIVE, IMAGE_MODEL, IMAGE_PRICE_USD


# extra columns added after the first version — migrated in on startup
_EXTRA_COLS = [
    ("cache_write_tok", "INTEGER DEFAULT 0"),
    ("cache_read_tok", "INTEGER DEFAULT 0"),
    ("web_searches", "INTEGER DEFAULT 0"),
]


def init_usage_table() -> None:
    """Create the llm_calls table if absent, and add any new columns to an
    existing (older-schema) table. Called from db.init_db()."""
    with _conn() as conn:
        conn.execute(
            f"""
            CREATE TABLE IF NOT EXISTS llm_calls (
                id             {_AUTO_ID},
                session_id     TEXT,
                stage          TEXT,
                model          TEXT,
                tier           TEXT,
                in_tok         INTEGER DEFAULT 0,
                out_tok        INTEGER DEFAULT 0,
                cache_write_tok INTEGER DEFAULT 0,
                cache_read_tok  INTEGER DEFAULT 0,
                web_searches    INTEGER DEFAULT 0,
                cost_usd       REAL DEFAULT 0,
                latency_ms     INTEGER DEFAULT 0,
                created_at     TEXT
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS ix_llm_calls_session ON llm_calls(session_id)")
        # migrate DBs created before these columns existed
        existing = _existing_columns(conn, "llm_calls")
        for col, decl in _EXTRA_COLS:
            if col not in existing:
                conn.execute(f"ALTER TABLE llm_calls ADD COLUMN {col} {decl}")


def record_call(
    session_id: Optional[str],
    stage: str,
    model: str,
    in_tok: int,
    out_tok: int,
    latency_ms: int = 0,
    cache_write: int = 0,
    cache_read: int = 0,
    web_searches: int = 0,
) -> None:
    """Log a single model call including cache tokens and server-side
    web_search requests. Never raises into the caller — tracking must not
    break the pipeline, so DB errors are swallowed (best-effort ledger)."""
    if not session_id:
        return
    try:
        c = cost_usd(model, in_tok or 0, out_tok or 0,
                     cache_write or 0, cache_read or 0, web_searches or 0)
        with _conn() as conn:
            conn.execute(
                f"INSERT INTO llm_calls "
                f"(session_id,stage,model,tier,in_tok,out_tok,cache_write_tok,cache_read_tok,"
                f"web_searches,cost_usd,latency_ms,created_at) "
                f"VALUES ({_PH},{_PH},{_PH},{_PH},{_PH},{_PH},{_PH},{_PH},{_PH},{_PH},{_PH},{_PH})",
                (session_id, stage, model, tier_of(model), in_tok or 0, out_tok or 0,
                 cache_write or 0, cache_read or 0, web_searches or 0,
                 c, latency_ms or 0, datetime.now(timezone.utc).isoformat()),
            )
    except Exception:  # noqa: BLE001 — a broken ledger must never break a run
        pass


def record_image_call(session_id: Optional[str], stage: str, count: int = 1) -> None:
    """Log slide-illustration image generations (flat per-image price, see
    core.pricing.IMAGE_PRICE_USD) — same ledger as text calls, so it shows up
    in the existing by-model / by-stage / trend breakdowns without any new UI."""
    if not session_id or count <= 0:
        return
    try:
        c = round(IMAGE_PRICE_USD * count, 6)
        with _conn() as conn:
            conn.execute(
                f"INSERT INTO llm_calls "
                f"(session_id,stage,model,tier,in_tok,out_tok,cache_write_tok,cache_read_tok,"
                f"web_searches,cost_usd,latency_ms,created_at) "
                f"VALUES ({_PH},{_PH},{_PH},{_PH},0,0,0,0,0,{_PH},0,{_PH})",
                (session_id, stage, IMAGE_MODEL, tier_of(IMAGE_MODEL),
                 c, datetime.now(timezone.utc).isoformat()),
            )
    except Exception:  # noqa: BLE001
        pass


def get_usage(session_id: str) -> dict:
    """Totals + per-stage + per-model breakdown for one session."""
    with _conn() as conn:
        total = conn.execute(
            "SELECT COUNT(*) calls, "
            "COALESCE(SUM(in_tok),0) in_tok, COALESCE(SUM(out_tok),0) out_tok, "
            "COALESCE(SUM(cache_write_tok),0) cache_write_tok, "
            "COALESCE(SUM(cache_read_tok),0) cache_read_tok, "
            "COALESCE(SUM(web_searches),0) web_searches, "
            "COALESCE(SUM(cost_usd),0) cost_usd, COALESCE(SUM(latency_ms),0) latency_ms "
            f"FROM llm_calls WHERE session_id = {_PH}",
            (session_id,),
        ).fetchone()

        by_stage = conn.execute(
            "SELECT stage, "
            "COUNT(*) calls, COALESCE(SUM(in_tok),0) in_tok, COALESCE(SUM(out_tok),0) out_tok, "
            "COALESCE(SUM(web_searches),0) web_searches, "
            "COALESCE(SUM(cost_usd),0) cost_usd, COALESCE(SUM(latency_ms),0) latency_ms "
            f"FROM llm_calls WHERE session_id = {_PH} GROUP BY stage ORDER BY SUM(cost_usd) DESC",
            (session_id,),
        ).fetchall()

        by_model = conn.execute(
            "SELECT model, tier, "
            "COUNT(*) calls, COALESCE(SUM(in_tok),0) in_tok, COALESCE(SUM(out_tok),0) out_tok, "
            "COALESCE(SUM(cost_usd),0) cost_usd "
            f"FROM llm_calls WHERE session_id = {_PH} GROUP BY model, tier ORDER BY SUM(cost_usd) DESC",
            (session_id,),
        ).fetchall()

    def d(row):
        return dict(row)

    return {
        "session_id": session_id,
        "prices_effective": PRICES_EFFECTIVE,
        "total": d(total) if total else {"calls": 0, "in_tok": 0, "out_tok": 0,
                                         "cost_usd": 0, "latency_ms": 0},
        "by_stage": [d(r) for r in by_stage],
        "by_model": [d(r) for r in by_model],
    }


def get_usage_trend(user_id: str, days: int = 30, tz_offset_min: int = 0) -> dict:
    """Per-day token + cost totals for one USER (across all their sessions),
    plus an all-time total. Joins llm_calls -> sessions by user_id.

    `tz_offset_min` is the browser's Date.getTimezoneOffset() (minutes; +480 for
    PST). created_at is stored in UTC, so we shift by -offset to group calls by
    the user's LOCAL calendar day instead of the UTC day.
    """
    shift = -int(tz_offset_min)              # local = utc - offset
    tz_mod = f"{shift:+d} minutes"           # e.g. "-480 minutes" (PST), "+330 minutes" (IST)
    with _conn() as conn:
        by_day = conn.execute(
            "SELECT substr(datetime(c.created_at, ?), 1, 10) AS day, "
            "COUNT(*) calls, COALESCE(SUM(c.in_tok),0) in_tok, "
            "COALESCE(SUM(c.out_tok),0) out_tok, COALESCE(SUM(c.cost_usd),0) cost_usd "
            "FROM llm_calls c JOIN sessions s ON c.session_id = s.id "
            f"WHERE s.user_id = {_PH} "
            "GROUP BY day ORDER BY day DESC "
            f"LIMIT {int(days)}",
            (tz_mod, user_id),
        ).fetchall()
        total = conn.execute(
            "SELECT COUNT(*) calls, COALESCE(SUM(c.in_tok),0) in_tok, "
            "COALESCE(SUM(c.out_tok),0) out_tok, COALESCE(SUM(c.cost_usd),0) cost_usd "
            "FROM llm_calls c JOIN sessions s ON c.session_id = s.id "
            f"WHERE s.user_id = {_PH}",
            (user_id,),
        ).fetchone()
        # Per-run time-series points (each review = one point at its date+time).
        # `at` = the run's LAST activity (MAX), so a paper-chat done later on an
        # existing run moves its point to the right and grows its bar — i.e. the
        # trend reflects your most recent activity. Raw UTC ISO; rendered local.
        by_session = conn.execute(
            "SELECT s.id, s.topic, MAX(c.created_at) AS at, "
            "COUNT(*) calls, COALESCE(SUM(c.in_tok),0) in_tok, "
            "COALESCE(SUM(c.out_tok),0) out_tok, COALESCE(SUM(c.cost_usd),0) cost_usd "
            "FROM llm_calls c JOIN sessions s ON c.session_id = s.id "
            f"WHERE s.user_id = {_PH} "
            "GROUP BY s.id ORDER BY at DESC LIMIT 60",
            (user_id,),
        ).fetchall()

        # All-time breakdown across every session for this user — lets the Usage
        # tab show a full by-model / by-stage picture even with no run open.
        by_stage = conn.execute(
            "SELECT c.stage, COUNT(*) calls, COALESCE(SUM(c.in_tok),0) in_tok, "
            "COALESCE(SUM(c.out_tok),0) out_tok, COALESCE(SUM(c.web_searches),0) web_searches, "
            "COALESCE(SUM(c.cost_usd),0) cost_usd, COALESCE(SUM(c.latency_ms),0) latency_ms "
            "FROM llm_calls c JOIN sessions s ON c.session_id = s.id "
            f"WHERE s.user_id = {_PH} GROUP BY c.stage ORDER BY SUM(c.cost_usd) DESC",
            (user_id,),
        ).fetchall()
        by_model = conn.execute(
            "SELECT c.model, c.tier, COUNT(*) calls, COALESCE(SUM(c.in_tok),0) in_tok, "
            "COALESCE(SUM(c.out_tok),0) out_tok, COALESCE(SUM(c.cost_usd),0) cost_usd "
            "FROM llm_calls c JOIN sessions s ON c.session_id = s.id "
            f"WHERE s.user_id = {_PH} GROUP BY c.model, c.tier ORDER BY SUM(c.cost_usd) DESC",
            (user_id,),
        ).fetchall()

        # This calendar month's spend so far, in the user's LOCAL timezone —
        # computed directly in SQL (not derived from by_day, which is capped
        # at `days` and would silently under-count once a month runs longer
        # than that window). "Pending amount" in the UI = this figure; there's
        # no real billing/subscription system, so it's presented as spend
        # tracking, not an amount owed.
        this_month = conn.execute(
            "SELECT COUNT(*) calls, COALESCE(SUM(c.cost_usd),0) cost_usd "
            "FROM llm_calls c JOIN sessions s ON c.session_id = s.id "
            f"WHERE s.user_id = {_PH} "
            "AND substr(datetime(c.created_at, ?), 1, 7) = substr(datetime('now', ?), 1, 7)",
            (user_id, tz_mod, tz_mod),
        ).fetchone()

    days_asc = [dict(r) for r in by_day][::-1]   # oldest -> newest for charting
    sessions_asc = [dict(r) for r in by_session][::-1]
    total_d = dict(total) if total else {"calls": 0, "in_tok": 0, "out_tok": 0, "cost_usd": 0}
    total_d.setdefault("latency_ms", 0)
    this_month_d = dict(this_month) if this_month else {"calls": 0, "cost_usd": 0}
    return {
        "prices_effective": PRICES_EFFECTIVE,
        "total": total_d,
        "this_month": this_month_d,
        "by_day": days_asc,
        "by_session": sessions_asc,
        "by_stage": [dict(r) for r in by_stage],
        "by_model": [dict(r) for r in by_model],
    }


def get_usage_breakdown(
    user_id: str,
    days: Optional[int] = None,
    project_id: Optional[str] = None,
    model: Optional[str] = None,
    tz_offset_min: int = 0,
) -> dict:
    """Usage grouped by RUN (search) and by PROJECT for one user, optionally
    limited to the last `days` days (None = all time).

    Written to be engine-agnostic (SQLite + Postgres): the time window is a
    plain ISO-string comparison on created_at (stored as UTC ISO text), and the
    per-project rollup is done in Python from the per-run rows — no
    datetime()/strftime() SQL, which differs between the two engines.
    Runs not filed under any project roll up into an "Unassigned" bucket.
    """
    from datetime import timedelta

    base_where = f"s.user_id = {_PH}"
    base_params: list = [user_id]
    if days:
        cutoff = (datetime.now(timezone.utc) - timedelta(days=int(days))).isoformat()
        base_where += f" AND c.created_at >= {_PH}"
        base_params.append(cutoff)

    # Optional filters layer on top of the user+range base. project_id == "none"
    # means "Unassigned" (no project, or a project that no longer exists).
    where, params = base_where, list(base_params)
    if project_id == "none":
        where += " AND (s.project_id IS NULL OR s.project_id = '' " \
                 "OR s.project_id NOT IN (SELECT id FROM projects))"
    elif project_id:
        where += f" AND s.project_id = {_PH}"
        params.append(project_id)
    if model:
        where += f" AND c.model = {_PH}"
        params.append(model)

    with _conn() as conn:
        # Per-call rows (4 narrow columns) so days can be bucketed in the
        # user's LOCAL time zone in Python — keeps the SQL engine-agnostic.
        call_rows = conn.execute(
            "SELECT c.created_at AS at, c.in_tok AS in_tok, c.out_tok AS out_tok, "
            "c.cost_usd AS cost_usd "
            f"FROM llm_calls c JOIN sessions s ON c.session_id = s.id WHERE {where}",
            tuple(params),
        ).fetchall()
        # Filter-dropdown options: every project/model seen in the range,
        # independent of the currently selected filters.
        opt_rows = conn.execute(
            "SELECT DISTINCT s.project_id AS project_id, c.model AS model "
            f"FROM llm_calls c JOIN sessions s ON c.session_id = s.id WHERE {base_where}",
            tuple(base_params),
        ).fetchall()
        rows = conn.execute(
            "SELECT s.id AS session_id, s.topic AS topic, s.project_id AS project_id, "
            "MAX(c.created_at) AS at, COUNT(*) AS calls, "
            "COALESCE(SUM(c.in_tok),0) AS in_tok, COALESCE(SUM(c.out_tok),0) AS out_tok, "
            "COALESCE(SUM(c.cost_usd),0) AS cost_usd "
            "FROM llm_calls c JOIN sessions s ON c.session_id = s.id "
            f"WHERE {where} "
            "GROUP BY s.id, s.topic, s.project_id ORDER BY MAX(c.created_at) DESC",
            tuple(params),
        ).fetchall()
        runs = [dict(r) for r in rows]

        names: dict = {}
        opt_list = [dict(o) for o in opt_rows]
        pids = sorted(
            {r["project_id"] for r in runs if r.get("project_id")}
            | {o["project_id"] for o in opt_list if o.get("project_id")}
        )
        if pids:
            marks = ",".join([_PH] * len(pids))
            for p in conn.execute(
                f"SELECT id, name FROM projects WHERE id IN ({marks})", tuple(pids)
            ).fetchall():
                p = dict(p)
                names[p["id"]] = p["name"]

    by_project: dict = {}
    total = {"calls": 0, "in_tok": 0, "out_tok": 0, "cost_usd": 0.0, "runs": len(runs)}
    for r in runs:
        pid = r.get("project_id") or None
        r["project_name"] = names.get(pid) if pid else None
        key = pid if pid in names else None   # deleted/unknown project -> Unassigned
        b = by_project.setdefault(key, {
            "project_id": key, "project_name": names.get(key) if key else "Unassigned",
            "runs": 0, "calls": 0, "in_tok": 0, "out_tok": 0, "cost_usd": 0.0, "last_at": None,
        })
        b["runs"] += 1
        for f in ("calls", "in_tok", "out_tok", "cost_usd"):
            b[f] += r[f] or 0
            total[f] += r[f] or 0
        if r["at"] and (b["last_at"] is None or r["at"] > b["last_at"]):
            b["last_at"] = r["at"]

    # Per-day rollup in the user's local time (created_at is UTC ISO text;
    # local = utc - offset, where offset is JS getTimezoneOffset()).
    by_day: dict = {}
    shift = timedelta(minutes=-int(tz_offset_min or 0))
    for r in call_rows:
        r = dict(r)
        try:
            ts = datetime.fromisoformat(str(r["at"]).replace("Z", "+00:00"))
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
            day = (ts + shift).strftime("%Y-%m-%d")
        except Exception:  # noqa: BLE001 — skip unparseable timestamps
            continue
        d = by_day.setdefault(day, {"day": day, "calls": 0, "in_tok": 0, "out_tok": 0, "cost_usd": 0.0})
        d["calls"] += 1
        d["in_tok"] += r["in_tok"] or 0
        d["out_tok"] += r["out_tok"] or 0
        d["cost_usd"] += r["cost_usd"] or 0

    # Dropdown options. Unassigned shows up if any call has no (valid) project.
    option_projects, has_unassigned = {}, False
    for o in opt_list:
        if o.get("project_id") and o["project_id"] in names:
            option_projects[o["project_id"]] = names[o["project_id"]]
        else:
            has_unassigned = True
    options = {
        "projects": [{"id": k, "name": v} for k, v in sorted(option_projects.items(), key=lambda kv: kv[1].lower())]
                    + ([{"id": "none", "name": "Unassigned"}] if has_unassigned else []),
        "models": sorted({o["model"] for o in opt_list if o.get("model")}),
    }

    return {
        "days": days,
        "total": total,
        "by_run": runs[:200],
        "by_project": sorted(by_project.values(), key=lambda b: b["cost_usd"], reverse=True),
        "by_day": [by_day[k] for k in sorted(by_day, reverse=True)],
        "options": options,
    }
