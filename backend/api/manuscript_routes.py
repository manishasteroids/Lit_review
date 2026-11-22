"""
Publish step routes -- turn a finished Sift review (and, when there is one,
the Infinity run built on it) into a manuscript in a venue's own format.

Flow, mirrored by frontend/src/components/PublishPanel.jsx:
  POST /open                 find or create the manuscript for a Sift run
  POST /{id}/template        upload a Word or LaTeX template -> format spec
  POST /{id}/guidelines      link to the venue's submission guidelines page
  PATCH /{id}                paper type, author details, spec edits, text edits
  POST /{id}/files           results: documents, data files, figures
  POST /{id}/generate        write the paper against the spec
  GET  /{id}/download        .docx (Word template) or .zip (LaTeX template)

Same one-directional boundary as api/hypothesis_routes.py: this module only
READS Sift and Infinity runs; it writes to its own two tables.
"""
import io
import logging
import re
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel

from agents.manuscript import (PAPER_TYPES, DiagramAgent, FormatAuditAgent, FormatSpecAgent,
                               LatexFrontMatterAgent, TemplateFormatAgent, clean_learned,
                               ManuscriptWriterAgent, build_context, default_sections,
                               normalize_spec)
from api.routes import _ordered_for_export, _safe_filename, get_run
from core import manuscript_db as mdb
from core import manuscript_diagrams as diagrams
from core import manuscript_render as render
from core import manuscript_template as tpl
from core.auth import require_user
from core.config import settings
from core.hypothesis_db import get_hypothesis_run
from core.llm_client import LLMClient

router = APIRouter(prefix="/api/manuscripts")
log = logging.getLogger("sift.manuscripts")

MAX_RESULT_BYTES = 20 * 1024 * 1024
MAX_RESULT_FILES = 12
_DOC_EXT = (".pdf", ".docx", ".txt", ".md")
_DATA_EXT = (".csv", ".tsv", ".xlsx", ".xls")
_IMG_EXT = (".png", ".jpg", ".jpeg")
_DETAIL_KEYS = ("title", "authors_text", "keywords", "funding", "conflicts", "acknowledgements",
                "data_availability", "ai_disclosure", "diagrams")
_NO_DIAGRAM = r"result|finding|evaluation|discussion|conclusion"


def _as_dict(x) -> dict:
    if isinstance(x, dict):
        return x
    return x.model_dump() if hasattr(x, "model_dump") else dict(x)


def _load(mid: str, user_id: str) -> dict:
    ms = mdb.get_manuscript(mid, user_id)
    if not ms:
        raise HTTPException(404, "Manuscript not found.")
    return ms


def _public(ms: dict, user_id: str) -> dict:
    data = {k: v for k, v in ms["data"].items() if k != "latex_head"}
    if data.get("template"):
        info = {k: v for k, v in (data["template"].get("info") or {}).items()
                if k not in ("main_excerpt", "outline", "style_names", "files", "format_outline")}
        data["template"] = {**data["template"], "info": info}
    for key in ("guidelines", "guidelines_file"):
        if data.get(key):
            data[key] = {k: v for k, v in data[key].items() if k != "text"}
    files = []
    for f in mdb.list_files(ms["id"], user_id, role="result"):
        meta = {k: v for k, v in f["meta"].items() if k not in ("text", "table")}
        files.append({"id": f["id"], "filename": f["filename"], "size": f["size"], **meta})
    drawn = [{"id": f["id"], **{k: v for k, v in f["meta"].items() if k != "spec"}}
             for f in mdb.list_files(ms["id"], user_id, role="diagram")]
    return {"id": ms["id"], "source_run_id": ms["source_run_id"], "hyp_run_id": ms["hyp_run_id"],
            "updated_at": ms["updated_at"], **data, "files": files, "diagrams": drawn}


def _recheck(data: dict, papers: list[dict], n_results: int) -> None:
    if data.get("manuscript"):
        data["checks"] = render.check(data["spec"], data["manuscript"], papers, data.get("details") or {},
                                      data["paper_type"], n_results)
        info = (data.get("template") or {}).get("info") or {}
        by_hand = [x["item"] for x in ((info.get("learned") or {}).get("by_hand") or [])]
        if by_hand:
            data["checks"].append({"label": "To finish by hand", "status": "warn",
                                   "detail": "The template calls for these, and they are not written for you: "
                                             + "; ".join(by_hand) + ". See the Format step for where each goes."})


def _papers(source) -> list[dict]:
    return [_as_dict(p) for p in _ordered_for_export(source)]


def _n_results(mid: str, user_id: str) -> int:
    return len(mdb.list_files(mid, user_id, role="result"))


# ── Open / read / edit ──────────────────────────────────────────────────────

class OpenBody(BaseModel):
    source_run_id: str
    hyp_run_id: str | None = None


@router.post("/open")
def open_manuscript(body: OpenBody, user_id: str = Depends(require_user)):
    source = get_run(body.source_run_id, user_id)          # ownership check, no LLM
    # The written review helps but is not required: the paper is written from
    # the analysed sources (extractions). What IS required is that the
    # sources have been analysed -- with nothing extracted there is nothing
    # to cite or write from.
    if not (source.extractions or []):
        raise HTTPException(400, "This run's sources have not been analysed yet. Open Sources and run the "
                                 "analysis first; the paper is written from what it extracts.")
    if body.hyp_run_id and not get_hypothesis_run(body.hyp_run_id, user_id):
        raise HTTPException(404, "Hypothesis run not found.")
    ms = mdb.latest_manuscript_for_run(user_id, body.source_run_id)
    if ms:
        if body.hyp_run_id and body.hyp_run_id != ms["hyp_run_id"]:
            ms = mdb.update_manuscript(ms["id"], user_id, ms["data"], hyp_run_id=body.hyp_run_id)
        return _public(ms, user_id)
    paper_type = "research" if body.hyp_run_id else "review"
    data = {
        "paper_type": paper_type,
        "details": {"ai_disclosure": True},
        "instructions": "",
        "results_notes": "",
        "template": None,
        "spec": normalize_spec(None, paper_type, None),
        "spec_source": "default",
        "manuscript": None,
        "checks": [],
    }
    return _public(mdb.create_manuscript(user_id, body.source_run_id, body.hyp_run_id, data), user_id)


def _blank(paper_type: str) -> dict:
    return {
        "paper_type": paper_type,
        "details": {"ai_disclosure": True},
        "instructions": "",
        "results_notes": "",
        "template": None,
        "spec": normalize_spec(None, paper_type, None),
        "spec_source": "default",
        "manuscript": None,
        "checks": [],
    }


@router.post("/{mid}/reset")
def reset_manuscript(mid: str, user_id: str = Depends(require_user)):
    """Start over: clears the template, guidelines, author details, results
    files, diagrams and the written text for this paper."""
    ms = _load(mid, user_id)
    for role in ("template", "result", "diagram"):
        mdb.delete_files_by_role(mid, user_id, role)
    return _public(mdb.update_manuscript(mid, user_id, _blank("research" if ms["hyp_run_id"] else "review")), user_id)


@router.get("/{mid}")
def get_manuscript(mid: str, user_id: str = Depends(require_user)):
    return _public(_load(mid, user_id), user_id)


class PatchBody(BaseModel):
    paper_type: str | None = None
    details: dict | None = None
    instructions: str | None = None
    results_notes: str | None = None
    spec: dict | None = None
    manuscript: dict | None = None
    approved: bool | None = None


@router.patch("/{mid}")
def patch_manuscript(mid: str, body: PatchBody, user_id: str = Depends(require_user)):
    ms = _load(mid, user_id)
    data = dict(ms["data"])
    info = (data.get("template") or {}).get("info")

    if body.paper_type is not None:
        if body.paper_type not in PAPER_TYPES:
            raise HTTPException(400, "paper_type must be 'review' or 'research'.")
        if body.paper_type != data["paper_type"]:
            data["paper_type"] = body.paper_type
            if data.get("spec_source") == "default":       # no template yet: swap the standard outline
                data["spec"] = {**data["spec"], "sections": default_sections(body.paper_type)}
    if body.details is not None:
        clean = {k: body.details[k] for k in _DETAIL_KEYS if k in body.details}
        for k, v in clean.items():
            if isinstance(v, str):
                clean[k] = v[:6000]
        data["details"] = {**(data.get("details") or {}), **clean}
    if body.instructions is not None:
        data["instructions"] = body.instructions[:6000]
    if body.results_notes is not None:
        data["results_notes"] = body.results_notes[:6000]
    if body.spec is not None:
        data["spec"] = normalize_spec(body.spec, data["paper_type"], info)
    if body.manuscript is not None and data.get("manuscript"):
        cur = dict(data["manuscript"])
        for k in ("title", "abstract"):
            if isinstance(body.manuscript.get(k), str):
                cur[k] = body.manuscript[k][:20000]
        if isinstance(body.manuscript.get("keywords"), list):
            cur["keywords"] = [str(x)[:80] for x in body.manuscript["keywords"]][:12]
        if isinstance(body.manuscript.get("sections"), dict):
            cur["sections"] = {**cur.get("sections", {}),
                               **{k: str(v)[:60000] for k, v in body.manuscript["sections"].items()}}
        data["manuscript"] = cur
        data["latex_head"] = None                           # title/keywords may have changed
        data["approved"] = False                            # edited text needs approving again
    if body.approved is not None and data.get("manuscript"):
        data["approved"] = bool(body.approved)
        data["approved_at"] = datetime.now(timezone.utc).isoformat() if body.approved else None

    _recheck(data, _papers(get_run(ms["source_run_id"], user_id)), _n_results(mid, user_id))
    return _public(mdb.update_manuscript(mid, user_id, data), user_id)


# ── Template -> format spec ────────────────────────────────────────────────

def _guide_text(data: dict) -> str:
    """Everything the user gave as reference on the venue's rules: the
    guidelines web page and/or an uploaded reference document."""
    parts = []
    link = data.get("guidelines") or {}
    if link.get("text"):
        parts.append(f"[Web page: {link.get('url')}]\n{link['text']}")
    doc = data.get("guidelines_file") or {}
    if doc.get("text"):
        parts.append(f"[Uploaded reference document: {doc.get('filename')}]\n{doc['text']}")
    return "\n\n".join(parts)


def _reference_excerpt(text: str) -> str:
    """A long upload (e.g. a 100-page sample paper) is cut to its opening
    plus its section headings, which is where format and structure show."""
    text = text.strip()
    if len(text) <= 14000:
        return text
    heads, seen = [], set()
    for line in text.splitlines():
        line = line.strip()
        if 3 < len(line) < 90 and re.match(r"^(\d+(\.\d+){0,2}\.?|[IVX]+\.|[A-Z]\.)\s+[A-Z]", line) and line not in seen:
            seen.add(line)
            heads.append(line)
    return (text[:10500] + "\n\n[... document continues ...]\n\nHEADINGS FOUND IN THE REST OF THE DOCUMENT:\n"
            + "\n".join(heads[:90]))[:14000]


def _learn_format(info: dict, api_key, model, run_id) -> None:
    """Have the model read a Word template and learn its format (which sample
    paragraph shows each part of a paper, what the author must do by hand).
    Stored on the template as info['learned']; the renderer uses it. On any
    failure the renderer falls back to its built-in rules of thumb."""
    if info.get("kind") != "docx" or not info.get("format_outline"):
        return
    try:
        llm = LLMClient(api_key=api_key, model=model or settings.mid_model or settings.model,
                        run_id=run_id, stage="manuscript_template_format")
        raw = TemplateFormatAgent(llm).run(info["format_outline"], info.get("columns") or 1,
                                           info.get("page_furniture") or [])
        info["learned"] = clean_learned(raw, info.get("n_paragraphs") or 0)
    except Exception as e:  # noqa: BLE001
        log.warning("Template format agent failed, using built-in rules: %s", e)
        info["learned"] = None


def _audit_format(mid: str, user_id: str, data: dict, papers: list[dict], api_key, model, run_id) -> list[dict] | None:
    """Build the Word file and have the model compare it with the template.
    Returns findings ([] = matches), or None when no audit could be run."""
    template = data.get("template")
    if not template or template["kind"] != "docx" or not template["info"].get("format_outline"):
        return None
    try:
        import docx
        raw = mdb.get_file_content(template["file_id"], user_id)
        _, figures, tables = _floats(mid, user_id, with_bytes=True)
        if data["paper_type"] != "research":
            figures, tables = [], []
        figures = render.order_figures(data["spec"], figures, _drawn(mid, user_id, with_bytes=True))
        built = render.render_docx(raw, data["spec"], data["manuscript"], papers, data.get("details") or {},
                                   figures, tables, template["info"])
        outline = tpl.format_outline(docx.Document(io.BytesIO(built)), head=70, tail=30)
        llm = LLMClient(api_key=api_key, model=model or settings.mid_model or settings.model,
                        run_id=run_id, stage="manuscript_format_audit")
        learned = template["info"].get("learned") or {}
        return FormatAuditAgent(llm).run(template["info"]["format_outline"], outline, learned.get("conventions") or [])
    except Exception as e:  # noqa: BLE001
        log.warning("Format audit failed: %s", e)
        return None


def _build_spec(data: dict, api_key, model, run_id) -> tuple[dict, str]:
    """Format spec from whatever the user has given so far: the template,
    the submission guidelines (link or uploaded document), or both."""
    info = (data.get("template") or {}).get("info")
    guide = _guide_text(data)
    paper_type = data["paper_type"]
    if not info and not guide:
        return normalize_spec(None, paper_type, None), "default"
    try:
        llm = LLMClient(api_key=api_key, model=model or settings.mid_model or settings.model,
                        run_id=run_id, stage="manuscript_format_spec")
        raw = FormatSpecAgent(llm).run(tpl.describe(info) if info else "", paper_type,
                                       data.get("instructions") or "", guide)
        return (normalize_spec(raw if isinstance(raw, dict) else None, paper_type, info),
                "template" if info else "guidelines")
    except Exception as e:  # noqa: BLE001 -- the template is still usable with a standard outline
        log.warning("Format spec agent failed, using the standard outline: %s", e)
        return normalize_spec(None, paper_type, info), "default"


@router.post("/{mid}/template")
async def upload_template(
    mid: str, file: UploadFile = File(...), api_key: str | None = Form(None),
    model: str | None = Form(None), user_id: str = Depends(require_user),
):
    ms = _load(mid, user_id)
    raw = await file.read()
    try:
        info = tpl.read_template(file.filename or "", raw)
    except tpl.TemplateError as e:
        raise HTTPException(400, str(e))
    data = dict(ms["data"])
    mdb.delete_files_by_role(mid, user_id, "template")
    saved = mdb.add_file(mid, user_id, "template", file.filename or "template", raw, {})
    info["outline"] = (info.get("outline") or [])[:140]
    _learn_format(info, api_key, model, ms["source_run_id"])
    data["template"] = {"file_id": saved["id"], "filename": saved["filename"], "kind": info["kind"], "info": info}
    data["spec"], data["spec_source"] = _build_spec(data, api_key, model, ms["source_run_id"])
    data["latex_head"] = None
    _recheck(data, _papers(get_run(ms["source_run_id"], user_id)), _n_results(mid, user_id))
    return _public(mdb.update_manuscript(mid, user_id, data), user_id)


class LlmBody(BaseModel):
    api_key: str | None = None
    model: str | None = None


@router.post("/{mid}/spec/rebuild")
def rebuild_spec(mid: str, body: LlmBody, user_id: str = Depends(require_user)):
    """Re-read the uploaded template for the current paper type / instructions."""
    ms = _load(mid, user_id)
    data = dict(ms["data"])
    if not data.get("template") and not _guide_text(data):
        raise HTTPException(400, "Upload a template or add submission guidelines first.")
    if data.get("template"):
        data["template"] = {**data["template"], "info": dict(data["template"]["info"])}
        _learn_format(data["template"]["info"], body.api_key, body.model, ms["source_run_id"])
    data["spec"], data["spec_source"] = _build_spec(data, body.api_key, body.model, ms["source_run_id"])
    _recheck(data, _papers(get_run(ms["source_run_id"], user_id)), _n_results(mid, user_id))
    return _public(mdb.update_manuscript(mid, user_id, data), user_id)


class GuidelinesBody(BaseModel):
    url: str = ""
    api_key: str | None = None
    model: str | None = None


@router.post("/{mid}/guidelines")
def set_guidelines(mid: str, body: GuidelinesBody, user_id: str = Depends(require_user)):
    """Read the venue's submission-guidelines page and fold what it says
    (limits, required statements, citation style) into the format spec. An
    empty url removes the link."""
    from core.paper_text import _is_safe_url, fetch_paper_text
    ms = _load(mid, user_id)
    data = dict(ms["data"])
    url = (body.url or "").strip()
    if not url:
        data["guidelines"] = None
    else:
        if not url.lower().startswith(("http://", "https://")):
            url = "https://" + url
        if len(url) > 600 or not _is_safe_url(url):
            raise HTTPException(400, "That link could not be used. Paste the public web address of the guidelines page.")
        text = (fetch_paper_text(url) or "").strip()
        if len(text) < 200:
            raise HTTPException(400, "That page could not be read (it may need a login or load its text with "
                                     "scripts). Paste the key rules into the instructions box instead.")
        data["guidelines"] = {"url": url, "text": text[:14000], "chars": len(text),
                              "fetched_at": datetime.now(timezone.utc).isoformat()}
    data["spec"], data["spec_source"] = _build_spec(data, body.api_key, body.model, ms["source_run_id"])
    _recheck(data, _papers(get_run(ms["source_run_id"], user_id)), _n_results(mid, user_id))
    return _public(mdb.update_manuscript(mid, user_id, data), user_id)


@router.post("/{mid}/guidelines/file")
async def upload_guidelines_file(
    mid: str, file: UploadFile = File(...), api_key: str | None = Form(None),
    model: str | None = Form(None), user_id: str = Depends(require_user),
):
    """A reference document on the venue's rules: its author instructions as
    a PDF, or a sample paper from the venue to copy the structure of. Only
    the extracted text is kept, not the file."""
    from core.paper_text import docx_bytes_to_text, pdf_bytes_to_text
    ms = _load(mid, user_id)
    raw = await file.read()
    name = file.filename or "reference"
    lower = name.lower()
    if len(raw) > MAX_RESULT_BYTES:
        raise HTTPException(400, f"File is over the {MAX_RESULT_BYTES // (1024 * 1024)}MB limit.")
    if lower.endswith(".pdf"):
        text = pdf_bytes_to_text(raw)
    elif lower.endswith(".docx"):
        text = docx_bytes_to_text(raw)
    elif lower.endswith((".txt", ".md")):
        text = raw.decode("utf-8", errors="replace")
    else:
        raise HTTPException(400, "Upload the guidelines as a PDF, DOCX, TXT or MD file.")
    text = (text or "").strip()
    if len(text) < 200:
        raise HTTPException(400, "No readable text was found in this file. A scanned PDF has to be "
                                 "converted to text (OCR) first.")
    data = dict(ms["data"])
    data["guidelines_file"] = {"filename": name[:200], "text": _reference_excerpt(text), "chars": len(text),
                               "added_at": datetime.now(timezone.utc).isoformat()}
    data["spec"], data["spec_source"] = _build_spec(data, api_key, model, ms["source_run_id"])
    _recheck(data, _papers(get_run(ms["source_run_id"], user_id)), _n_results(mid, user_id))
    return _public(mdb.update_manuscript(mid, user_id, data), user_id)


@router.delete("/{mid}/guidelines/file")
def remove_guidelines_file(mid: str, user_id: str = Depends(require_user)):
    """Drops the reference document. The outline keeps whatever was read
    from it until the template or link is read again."""
    ms = _load(mid, user_id)
    data = dict(ms["data"])
    data["guidelines_file"] = None
    return _public(mdb.update_manuscript(mid, user_id, data), user_id)


# ── Results files ───────────────────────────────────────────────────────────

def _read_result(filename: str, raw: bytes) -> dict:
    lower = filename.lower()
    if lower.endswith(_IMG_EXT):
        return {"kind": "image", "include": True}
    if lower.endswith(_DATA_EXT):
        from core.data_ingest import IngestError, load_table, profile
        try:
            df = load_table(raw, filename)
        except IngestError as e:
            raise HTTPException(400, str(e))
        prof = profile(df)
        cols = [c for c in prof["columns"]]
        summary = [f"{prof['row_count']} rows x {prof['column_count']} columns."]
        for c in cols[:40]:
            if c["dtype"] == "numeric" and "mean" in c:
                summary.append(f"- {c['name']}: numeric, min {c['min']:.4g}, max {c['max']:.4g}, "
                               f"mean {c['mean']:.4g}, sd {c['std']:.4g}")
            else:
                tops = ", ".join(f"{t['value']} ({t['count']})" for t in c.get("top_values", [])[:5])
                summary.append(f"- {c['name']}: categorical, {c['n_unique']} values" + (f"; most common: {tops}" if tops else ""))
        head = df.head(40)
        text = "\n".join(summary) + "\nFirst rows (CSV):\n" + head.to_csv(index=False)[:9000]
        small = df.iloc[:15, :8]
        table = {"columns": [str(c) for c in small.columns],
                 "rows": [[None if v != v else (round(v, 4) if isinstance(v, float) else str(v) if not isinstance(v, (int, float)) else v)
                           for v in row] for row in small.itertuples(index=False, name=None)]}
        return {"kind": "data", "include": False, "text": text, "table": table,
                "rows": prof["row_count"], "cols": prof["column_count"]}
    if lower.endswith(_DOC_EXT):
        from core.paper_text import docx_bytes_to_text, pdf_bytes_to_text
        if lower.endswith(".pdf"):
            text = pdf_bytes_to_text(raw)
        elif lower.endswith(".docx"):
            text = docx_bytes_to_text(raw)
        else:
            text = raw.decode("utf-8", errors="replace")
        if not (text or "").strip():
            raise HTTPException(400, "No readable text was found in this file.")
        return {"kind": "document", "include": True, "text": text[:24000]}
    raise HTTPException(400, "Unsupported file. Use PDF, DOCX, TXT or MD for documents; CSV, TSV or XLSX "
                             "for data; PNG or JPG for figures.")


@router.post("/{mid}/files")
async def upload_result(
    mid: str, file: UploadFile = File(...), description: str = Form(""),
    user_id: str = Depends(require_user),
):
    ms = _load(mid, user_id)
    if _n_results(mid, user_id) >= MAX_RESULT_FILES:
        raise HTTPException(400, f"Up to {MAX_RESULT_FILES} results files per manuscript.")
    raw = await file.read()
    if not raw:
        raise HTTPException(400, "This file is empty.")
    if len(raw) > MAX_RESULT_BYTES:
        raise HTTPException(400, f"File is over the {MAX_RESULT_BYTES // (1024 * 1024)}MB limit.")
    meta = _read_result(file.filename or "file", raw)
    meta["description"] = (description or "")[:2000]
    mdb.add_file(mid, user_id, "result", file.filename or "file", raw, meta)
    return _public(_load(mid, user_id), user_id)


class FilePatchBody(BaseModel):
    description: str | None = None
    include: bool | None = None


@router.patch("/{mid}/files/{fid}")
def patch_result(mid: str, fid: str, body: FilePatchBody, user_id: str = Depends(require_user)):
    ms = _load(mid, user_id)
    match = next((f for f in mdb.list_files(mid, user_id) if f["id"] == fid and f["role"] != "template"), None)
    if not match:
        raise HTTPException(404, "File not found.")
    meta = dict(match["meta"])
    if body.description is not None:
        meta["description"] = body.description[:2000]
    if body.include is not None:
        meta["include"] = bool(body.include)
    mdb.update_file_meta(fid, user_id, meta)
    return _public(_unapprove(ms, user_id), user_id)


@router.delete("/{mid}/files/{fid}")
def delete_result(mid: str, fid: str, user_id: str = Depends(require_user)):
    ms = _load(mid, user_id)
    if not any(f["id"] == fid and f["role"] != "template" for f in mdb.list_files(mid, user_id)):
        raise HTTPException(404, "File not found.")
    mdb.delete_file(fid, user_id)
    return _public(_unapprove(ms, user_id), user_id)


@router.get("/{mid}/files/{fid}/image")
def file_image(mid: str, fid: str, user_id: str = Depends(require_user)):
    """The picture itself, for the panel's previews (drawn diagrams and
    uploaded figures)."""
    _load(mid, user_id)
    match = next((f for f in mdb.list_files(mid, user_id) if f["id"] == fid), None)
    if not match or not (match["role"] == "diagram" or match["meta"].get("kind") == "image"):
        raise HTTPException(404, "Image not found.")
    name = match["filename"].lower()
    media = "image/jpeg" if name.endswith((".jpg", ".jpeg")) else "image/png"
    return Response(content=mdb.get_file_content(fid, user_id) or b"", media_type=media,
                    headers={"Cache-Control": "private, max-age=300"})


def _unapprove(ms: dict, user_id: str) -> dict:
    """Changing a figure, caption or results file changes what the file will
    contain, so an earlier approval no longer covers it."""
    if ms["data"].get("approved"):
        return mdb.update_manuscript(ms["id"], user_id, {**ms["data"], "approved": False, "approved_at": None})
    return ms


def _drawn(mid: str, user_id: str, with_bytes: bool) -> list[dict]:
    """Concept diagrams the agent drew, as figures tied to a section."""
    out = []
    for f in mdb.list_files(mid, user_id, role="diagram"):
        m = f["meta"]
        out.append({"filename": f["filename"], "caption": (m.get("description") or "").strip() or "Concept diagram",
                    "section": m.get("section_key"), "mention": m.get("mention") or "",
                    "bytes": mdb.get_file_content(f["id"], user_id) if with_bytes else None})
    return out


def _draw_diagrams(mid: str, user_id: str, spec: dict, text: dict, api_key, model, run_id) -> int:
    """Ask the agent where a concept diagram helps, draw each one, and store
    it. Replaces any diagrams from an earlier draft. Never raises: a paper
    without diagrams is still a paper."""
    mdb.delete_files_by_role(mid, user_id, "diagram")
    sections = [(s["heading"], (text.get("sections") or {}).get(s["key"], "")) for s in spec["sections"]
                if not re.search(_NO_DIAGRAM, s["heading"], re.I)]
    by_heading = {s["heading"].strip().lower(): s["key"] for s in spec["sections"]}
    try:
        llm = LLMClient(api_key=api_key, model=model, run_id=run_id, stage="manuscript_diagrams")
        proposals = DiagramAgent(llm).run(text.get("title") or "", sections)
    except Exception as e:  # noqa: BLE001
        log.warning("Diagram agent failed: %s", e)
        return 0
    n, used = 0, set()
    for p in proposals:
        key = by_heading.get(str(p.get("section") or "").strip().lower())
        clean = diagrams.clean_spec(p)
        if not key or key in used or not clean or re.search(_NO_DIAGRAM, str(p.get("section")), re.I):
            continue
        try:
            png = diagrams.render(clean)
        except Exception as e:  # noqa: BLE001
            log.warning("Diagram render failed: %s", e)
            continue
        mention = str(p.get("mention") or "").strip()[:300]
        n += 1
        used.add(key)
        mdb.add_file(mid, user_id, "diagram", f"diagram{n}.png", png, {
            "kind": clean["kind"], "section_key": key, "section": p.get("section"),
            "description": str(p.get("caption") or "").strip()[:400],
            "mention": mention if "{fig}" in mention else "", "spec": clean,
        })
    return n


def _floats(mid: str, user_id: str, with_bytes: bool) -> tuple[list[dict], list[dict], list[dict]]:
    """(text materials, figures, tables) from the uploaded results files."""
    materials, figures, tables = [], [], []
    for f in mdb.list_files(mid, user_id, role="result"):
        m = f["meta"]
        desc = (m.get("description") or "").strip()
        if m.get("kind") == "image":
            if not m.get("include", True):
                continue
            ext = f["filename"].rsplit(".", 1)[-1].lower()
            n = len(figures) + 1
            figures.append({"n": n, "filename": f["filename"], "caption": desc or f["filename"],
                            "outname": f"fig{n}.{ext}", "section": None, "mention": "",
                            "bytes": mdb.get_file_content(f["id"], user_id) if with_bytes else None})
            continue
        if m.get("kind") == "data" and m.get("include") and m.get("table"):
            tables.append({"n": len(tables) + 1, "caption": desc or f["filename"], **m["table"]})
        materials.append({"filename": f["filename"], "description": desc, "text": m.get("text") or ""})
    return materials, figures, tables


# ── Generate ────────────────────────────────────────────────────────────────

@router.post("/{mid}/generate")
def generate(mid: str, body: LlmBody, user_id: str = Depends(require_user)):
    ms = _load(mid, user_id)
    data = dict(ms["data"])
    source = get_run(ms["source_run_id"], user_id)
    papers = _papers(source)
    if not papers:
        raise HTTPException(400, "This review has no sources to cite.")
    research = data["paper_type"] == "research"

    hypothesis, meta_review = None, None
    if ms["hyp_run_id"]:
        hyp = get_hypothesis_run(ms["hyp_run_id"], user_id)
        d = (hyp or {}).get("data") or {}
        hyps = (d.get("plan") or {}).get("hypotheses") or []
        ci = d.get("champion_index")
        if hyps:
            hypothesis = hyps[ci] if isinstance(ci, int) and 0 <= ci < len(hyps) else hyps[0]
            meta_review = d.get("meta_review")

    materials, figures, tables = _floats(mid, user_id, with_bytes=False)
    if not research:
        materials, figures, tables = [], [], []

    spec = normalize_spec(data.get("spec"), data["paper_type"], (data.get("template") or {}).get("info"))
    details = data.get("details") or {}
    context = build_context(
        topic=source.topic, papers=papers,
        extractions_by_idx={_as_dict(e).get("idx"): _as_dict(e) for e in (source.extractions or [])},
        synthesis=_as_dict(source.synthesis) if source.synthesis else None,
        review_sections=source.sections or {}, hypothesis=hypothesis, meta_review=meta_review,
        results=materials, results_notes=(data.get("results_notes") or "") if research else "",
        figures=figures, tables=tables, instructions=data.get("instructions") or "",
        guidelines=_guide_text(data),
    )
    model = body.model or settings.write_model or settings.model
    try:
        llm = LLMClient(api_key=body.api_key, model=model, run_id=ms["source_run_id"], stage="manuscript_writer")
        text = ManuscriptWriterAgent(llm).run(context, spec, data["paper_type"],
                                              title_hint=details.get("title") or "",
                                              keywords_hint=details.get("keywords") or "")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Writing the manuscript failed: {e}")

    data["spec"], data["manuscript"], data["latex_head"] = spec, text, None
    data["approved"], data["approved_at"] = False, None     # a new draft is never pre-approved
    data["generated_at"] = datetime.now(timezone.utc).isoformat()
    n_drawn = 0
    if details.get("diagrams", True):
        n_drawn = _draw_diagrams(mid, user_id, spec, text, body.api_key, settings.mid_model or model,
                                 ms["source_run_id"])
    else:
        mdb.delete_files_by_role(mid, user_id, "diagram")
    data["used"] = {"hypothesis": bool(hypothesis), "results_files": len(materials) + len(figures),
                    "figures": len(figures), "tables": len(tables), "diagrams": n_drawn}

    template = data.get("template")
    if template and template["kind"] == "latex":            # fill the class's own author commands once, here
        try:
            raw = mdb.get_file_content(template["file_id"], user_id)
            head = render.latex_head_for_agent(tpl.unpack_latex(template["filename"], raw), template["info"])
            if head:
                fm = LLMClient(api_key=body.api_key, model=settings.mid_model or model,
                               run_id=ms["source_run_id"], stage="manuscript_latex_frontmatter")
                out = LatexFrontMatterAgent(fm).run(
                    head, text["title"], render.parse_authors(details.get("authors_text")), text["keywords"],
                    {k: details.get(k) for k in ("funding",) if details.get(k)})
                data["latex_head"] = out if render._valid_head(out) else None
        except Exception as e:  # noqa: BLE001 -- the renderer has a plain \title/\author fallback
            log.warning("LaTeX front-matter agent failed: %s", e)

    data["format_review"] = _audit_format(mid, user_id, data, papers, body.api_key, settings.mid_model or model,
                                          ms["source_run_id"])
    _recheck(data, papers, _n_results(mid, user_id) if research else 0)
    return _public(mdb.update_manuscript(mid, user_id, data), user_id)


# ── Download ────────────────────────────────────────────────────────────────

_BUILTIN_TEX = r"""\documentclass[11pt]{article}
\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage[margin=1in]{geometry}
\usepackage{graphicx}
\usepackage{url}
\title{Title}
\author{Author}
\begin{document}
\maketitle
\section{Introduction}
\end{document}
"""


def _builtin_template(fmt: str | None) -> tuple[dict, bytes]:
    """No template uploaded (e.g. only a guidelines link, or a venue like
    arXiv that has no template of its own): a plain single-column layout, as
    Word or as a standard LaTeX article."""
    if fmt == "latex":
        name, raw = "_builtin.tex", _BUILTIN_TEX.encode()
        return {"kind": "latex", "filename": name, "info": tpl.read_latex(name, raw)}, raw
    raw = _standard_docx()
    info = tpl.read_docx(raw)
    info["number_headings"] = True
    return {"kind": "docx", "filename": "standard.docx", "info": info}, raw


def _standard_docx() -> bytes:
    """A blank Word file styled like a preprint -- serif type, centred title
    and authors, black headings, justified text -- instead of Word's default
    office look (blue sans-serif headings)."""
    import docx
    from docx.enum.style import WD_STYLE_TYPE
    from docx.enum.text import WD_ALIGN_PARAGRAPH as AL
    from docx.oxml.ns import qn
    from docx.shared import Inches, Pt, RGBColor

    doc = docx.Document()
    sec = doc.sections[0]
    sec.left_margin = sec.right_margin = Inches(1.15)
    sec.top_margin = sec.bottom_margin = Inches(1)

    def style(name, size, align=None, bold=False, italic=False, before=0, after=6, base="Normal"):
        try:
            st = doc.styles[name]
        except KeyError:
            st = doc.styles.add_style(name, WD_STYLE_TYPE.PARAGRAPH)
            st.base_style = doc.styles[base]
        st.font.name, st.font.size = "Times New Roman", Pt(size)
        st.font.bold, st.font.italic = bold, italic
        st.font.color.rgb = RGBColor(0, 0, 0)
        rpr = st.element.get_or_add_rPr()
        fonts = rpr.find(qn("w:rFonts"))
        if fonts is not None:                       # theme fonts would override the name above
            for k in [k for k in fonts.attrib if "theme" in k.lower()]:
                del fonts.attrib[k]
            fonts.set(qn("w:eastAsia"), "Times New Roman")
            fonts.set(qn("w:cs"), "Times New Roman")
        color = rpr.find(qn("w:color"))
        if color is not None:                       # a theme colour (Word's blue) would win over black
            for k in [k for k in color.attrib if "theme" in k.lower()]:
                del color.attrib[k]
        pf = st.paragraph_format
        pf.space_before, pf.space_after = Pt(before), Pt(after)
        if align is not None:
            pf.alignment = align
        ppr = st.element.find(qn("w:pPr"))
        if ppr is not None and ppr.find(qn("w:pBdr")) is not None:
            ppr.remove(ppr.find(qn("w:pBdr")))      # the default Title style's blue rule
        return st

    style("Normal", 11)
    style("Body Text", 11, AL.JUSTIFY, after=8).paragraph_format.line_spacing = 1.1
    style("Title", 18, AL.CENTER, before=6, after=14)
    style("Author", 12, AL.CENTER, after=2)
    style("Affiliation", 10, AL.CENTER, italic=True, after=2)
    ab = style("Abstract", 10.5, AL.JUSTIFY, before=10, after=6)
    ab.paragraph_format.left_indent = ab.paragraph_format.right_indent = Inches(0.45)
    kw = style("Keywords", 10.5, AL.LEFT, after=14)
    kw.paragraph_format.left_indent = kw.paragraph_format.right_indent = Inches(0.45)
    style("Heading 1", 13, AL.LEFT, bold=True, before=16, after=6)
    style("Heading 2", 11.5, AL.LEFT, bold=True, before=10, after=4)
    rf = style("References", 10, AL.LEFT, after=3)
    rf.paragraph_format.left_indent, rf.paragraph_format.first_line_indent = Inches(0.35), Inches(-0.35)
    style("Caption", 10, AL.CENTER, before=4, after=10)
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


@router.get("/{mid}/download")
def download(mid: str, fmt: str | None = None, preview: bool = False, user_id: str = Depends(require_user)):
    """With a template: that template's format. Without one: `fmt` picks a
    standard layout, 'docx' (default) or 'latex'.

    preview=true is for the in-app viewer: always the standard Word layout,
    whatever the template. A browser cannot compile LaTeX, and it lays out
    multi-column publisher templates (IEEE's, for one) badly enough to
    mislead, so the viewer shows the same text, figures and references in a
    plain layout instead. Allowed before approval, since reading the paper
    is how the author decides whether to approve."""
    ms = _load(mid, user_id)
    data = ms["data"]
    if not data.get("manuscript"):
        raise HTTPException(400, "Generate the manuscript first.")
    if not data.get("approved") and not preview:
        raise HTTPException(400, "Approve the text before downloading the file.")
    template = data.get("template")
    if preview:
        template, fmt = None, "docx"
    if template:
        raw = mdb.get_file_content(template["file_id"], user_id)
        if raw is None:
            raise HTTPException(400, "The template file is missing -- upload it again.")
    else:
        template, raw = _builtin_template(fmt)
    papers = _papers(get_run(ms["source_run_id"], user_id))
    _, figures, tables = _floats(mid, user_id, with_bytes=True)
    if data["paper_type"] != "research":
        figures, tables = [], []
    figures = render.order_figures(data["spec"], figures, _drawn(mid, user_id, with_bytes=True))
    stem = _safe_filename(data["manuscript"].get("title") or "manuscript")
    details = data.get("details") or {}
    try:
        if template["kind"] == "docx":
            content = render.render_docx(raw, data["spec"], data["manuscript"], papers, details,
                                         figures, tables, template["info"])
            media, ext = "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"
        else:
            content, _ = render.render_latex(template["filename"], raw, template["info"], data["spec"],
                                             data["manuscript"], papers, details, figures, tables,
                                             data.get("latex_head"))
            media, ext = "application/zip", "zip"
    except Exception as e:  # noqa: BLE001
        log.exception("Manuscript render failed")
        raise HTTPException(500, f"Could not build the file from this template: {e}")
    return Response(content=content, media_type=media,
                    headers={"Content-Disposition": f'attachment; filename="{stem}.{ext}"'})
