"""
Document exporters — slide deck, PDF report and templated manuscript.

All generated locally from content the pipeline already produced (sections,
papers, synthesis, comparison table, year distribution). No LLM calls here,
so exporting costs nothing.

Formats:
  build_pptx()  -> slide deck (.pptx) — includes a real data table and a
                   native chart slide, not just bullet points.
  build_pdf()   -> formatted report (.pdf) — mirrors the in-app Review tab
                   exactly (written sections + a plain reference list).
  build_docx()  -> manuscript in an IEEE / arXiv style template (.docx).

Citations: references are plain, standard bibliographic text (no
hyperlinks) — the inline "[n]" markers within the written prose are the
clickable part, each linking to that paper's URL.

Text sanitization: paper metadata pulled from external APIs sometimes carries
Unicode punctuation (odd dash/hyphen variants, smart quotes) that the core
PDF/DOCX fonts can't render, showing up as black-box "missing glyph" marks.
`_sanitize()` normalizes that away before anything is written out.
"""
import io
import re
import unicodedata
from datetime import date

SECTION_ORDER = [
    ("abstract", "Abstract"),
    ("intro", "Introduction"),
    ("synthesis", "Literature Review"),
    ("gaps", "Gaps and Limitations"),
    ("future", "Future Directions and Conclusion"),
]

ACCENT = (0x5B, 0x4F, 0xF0)
LINK_COLOR = (0x1A, 0x5F, 0xD9)


# ── text sanitization ────────────────────────────────────────────────────────

# Various dash/hyphen/minus lookalikes that fall outside the core PDF/DOCX
# fonts' supported glyph set and render as a black box — fold them all to a
# plain hyphen. (U+2010..U+2015 dash forms, U+2212 minus sign.)
_DASH_CHARS = "‐‑‒–—―−"
_QUOTE_MAP = {
    "‘": "'", "’": "'", "‚": "'", "‛": "'", "ʼ": "'", "´": "'", "′": "'", "`": "'",
    "“": '"', "”": '"', "„": '"', "‟": '"',
}
_TAG_RE = re.compile(r"</?[a-zA-Z][a-zA-Z0-9]*(?:\s[^<>]*)?>")


def _sanitize(text) -> str:
    """Normalize Unicode punctuation that commonly shows up as a missing-
    glyph box in exported PDFs/DOCX (odd dashes, smart quotes, stray
    replacement characters from an upstream encoding hiccup), and strip stray
    HTML/XML markup (e.g. "<scp>A</scp>lzheimer's disease") that some source
    APIs (Semantic Scholar / OpenAlex) leak straight through in titles."""
    if not text:
        return ""
    t = unicodedata.normalize("NFKC", str(text))
    t = _TAG_RE.sub("", t)
    for d in _DASH_CHARS:
        t = t.replace(d, "-")
    for k, v in _QUOTE_MAP.items():
        t = t.replace(k, v)
    t = t.replace("�", "")  # the literal "unknown character" replacement glyph
    return "".join(ch for ch in t if ch == "\n" or ch.isprintable())


# ── inline [n] citation linking ─────────────────────────────────────────────
# References themselves stay plain, standard bibliographic text (no
# hyperlinks) — that's the convention. Instead, the inline "[n]" citation
# markers that already appear throughout the written prose are what get
# turned into clickable links, each pointing at that specific paper's URL.

_CITE_RE = re.compile(r"(\[\d+\])")


def _split_citations(text: str) -> list[tuple[str, int | None]]:
    """Split text into (segment, citation_number) pairs. citation_number is
    None for a plain-text segment, or the int inside a "[n]" marker."""
    out = []
    for part in _CITE_RE.split(text or ""):
        if not part:
            continue
        m = re.fullmatch(r"\[(\d+)\]", part)
        out.append((part, int(m.group(1)) if m else None))
    return out


def citation_urls(papers: list[dict]) -> dict[int, str]:
    """Map citation number (1-based, matching reference_list()'s numbering)
    -> that paper's URL, for linking inline [n] markers."""
    out = {}
    for i, p in enumerate(papers or [], 1):
        url = (p.get("url") or "").strip()
        if url:
            out[i] = url
    return out


def _paras(text: str) -> list[str]:
    return [_sanitize(p.strip()) for p in re.split(r"\n\s*\n", text or "") if p.strip()]


def review_title(sections: dict, topic: str) -> str:
    return _sanitize((sections or {}).get("title") or (topic or "Literature Review"))


def reference_list(papers: list[dict]) -> list[dict]:
    """IEEE-style numbered references in citation order, as
    {"text": "...", "url": "..."} so exporters can make them clickable."""
    out = []
    for i, p in enumerate(papers or [], 1):
        authors = _sanitize(p.get("authors")) or "—"
        title = _sanitize(p.get("title"))
        venue = _sanitize(p.get("venue")) or "preprint"
        year = p.get("year") or "n.d."
        out.append({
            "text": f'[{i}] {authors}, "{title}," {venue}, {year}.',
            "url": (p.get("url") or "").strip(),
        })
    return out


# ── PPTX ───────────────────────────────────────────────────────────────────

def build_pptx(topic: str, sections: dict, papers: list[dict], synthesis: dict,
                comparison: list[dict] | None = None, year_dist: list[dict] | None = None) -> bytes:
    from pptx import Presentation
    from pptx.util import Inches, Pt
    from pptx.dml.color import RGBColor
    from pptx.chart.data import CategoryChartData
    from pptx.enum.chart import XL_CHART_TYPE

    prs = Presentation()
    prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)   # 16:9
    accent = RGBColor(*ACCENT)
    link_rgb = RGBColor(*LINK_COLOR)
    title = review_title(sections, topic)
    cite_urls = citation_urls(papers)

    def bullets_slide(heading, bullets, note=None, linkify=False):
        s = prs.slides.add_slide(prs.slide_layouts[1])
        s.shapes.title.text = heading
        s.shapes.title.text_frame.paragraphs[0].runs[0].font.size = Pt(30)
        s.shapes.title.text_frame.paragraphs[0].runs[0].font.color.rgb = accent
        body = s.placeholders[1].text_frame
        body.word_wrap = True
        first = True
        for b in bullets:
            p = body.paragraphs[0] if first else body.add_paragraph()
            segs = _split_citations(b) if linkify else [(b, None)]
            for seg, num in segs:
                run = p.add_run()
                run.text = seg
                run.font.size = Pt(16)
                if num and cite_urls.get(num):
                    run.hyperlink.address = cite_urls[num]
                    run.font.color.rgb = link_rgb
                    run.font.underline = True
            first = False
        if note:
            s.notes_slide.notes_text_frame.text = note
        return s

    def blank_titled_slide(heading):
        s = prs.slides.add_slide(prs.slide_layouts[5])  # title-only layout
        s.shapes.title.text = heading
        s.shapes.title.text_frame.paragraphs[0].runs[0].font.size = Pt(28)
        s.shapes.title.text_frame.paragraphs[0].runs[0].font.color.rgb = accent
        return s

    # Title slide
    s0 = prs.slides.add_slide(prs.slide_layouts[0])
    s0.shapes.title.text = title
    s0.shapes.title.text_frame.paragraphs[0].runs[0].font.size = Pt(38)
    s0.shapes.title.text_frame.paragraphs[0].runs[0].font.color.rgb = accent
    s0.placeholders[1].text = (
        f"A literature review of {len(papers)} sources\n"
        f"Generated by Sift · {date.today().isoformat()}"
    )

    # Content slides from each written section
    for key, label in SECTION_ORDER:
        text = (sections or {}).get(key)
        if not text:
            continue
        chunks = _paras(text)
        # split long sections across slides (max ~5 bullets each)
        bullets = []
        for c in chunks:
            for sent in re.split(r"(?<=[.!?])\s+", c):
                sent = sent.strip()
                if len(sent) > 12:
                    bullets.append(sent if len(sent) <= 220 else sent[:217] + "…")
        for n in range(0, len(bullets), 5):
            part = bullets[n:n + 5]
            head = label if n == 0 else f"{label} (cont.)"
            bullets_slide(head, part, linkify=True)

    # Themes & gaps from the synthesis
    themes = [_sanitize(t) for t in ((synthesis or {}).get("themes") or [])]
    gaps = [_sanitize(g) for g in ((synthesis or {}).get("gaps") or [])]
    if themes:
        bullets_slide("Key Themes", themes[:6])
    if gaps:
        bullets_slide("Research Gaps", gaps[:6])

    # ── Data: publication-year chart (a real native chart, not a bullet list) ──
    if year_dist and len(year_dist) > 1:
        s = blank_titled_slide("Papers by Publication Year")
        chart_data = CategoryChartData()
        chart_data.categories = [str(d.get("year", "?")) for d in year_dist]
        chart_data.add_series("Papers", [d.get("count", 0) for d in year_dist])
        x, y, cx, cy = Inches(1.0), Inches(1.6), Inches(11.3), Inches(5.4)
        gframe = s.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, x, y, cx, cy, chart_data)
        chart = gframe.chart
        chart.has_legend = False
        try:
            plot = chart.plots[0]
            plot.series[0].format.fill.solid()
            plot.series[0].format.fill.fore_color.rgb = accent
        except Exception:
            pass

    # ── Data: comparison table (real pptx table, not bullets) ──
    if comparison:
        rows_per_slide = 8
        cols = ["#", "Paper", "Year", "Method", "Key finding"]
        for start in range(0, len(comparison), rows_per_slide):
            chunk = comparison[start:start + rows_per_slide]
            label = "Paper Comparison" if start == 0 else "Paper Comparison (cont.)"
            s = blank_titled_slide(label)
            nrows, ncols = len(chunk) + 1, len(cols)
            x, y, cx, cy = Inches(0.5), Inches(1.5), Inches(12.3), Inches(5.5)
            tbl_shape = s.shapes.add_table(nrows, ncols, x, y, cx, cy)
            tbl = tbl_shape.table
            widths = [Inches(0.5), Inches(4.6), Inches(0.9), Inches(2.8), Inches(3.5)]
            for i, w in enumerate(widths):
                tbl.columns[i].width = w
            for c, head in enumerate(cols):
                cell = tbl.cell(0, c)
                cell.text = head
                cell.text_frame.paragraphs[0].runs[0].font.bold = True
                cell.text_frame.paragraphs[0].runs[0].font.size = Pt(12)
                cell.fill.solid()
                cell.fill.fore_color.rgb = accent
                cell.text_frame.paragraphs[0].runs[0].font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
            for r, row in enumerate(chunk, start=1):
                vals = [
                    str(start + r),  # display rank (1-based position), not the raw paper idx
                    _sanitize(row.get("title"))[:90],
                    str(row.get("year") or "—"),
                    _sanitize(row.get("method"))[:60] or "—",
                    _sanitize(row.get("finding"))[:90] or "—",
                ]
                for c, v in enumerate(vals):
                    cell = tbl.cell(r, c)
                    cell.text = v
                    cell.text_frame.paragraphs[0].runs[0].font.size = Pt(10.5)

    # References — standard bibliographic text, not hyperlinked (the inline
    # [n] markers in the section slides above carry the links instead).
    refs = reference_list(papers)
    for n in range(0, len(refs), 8):
        chunk = refs[n:n + 8]
        s = prs.slides.add_slide(prs.slide_layouts[1])
        s.shapes.title.text = "References" if n == 0 else "References (cont.)"
        s.shapes.title.text_frame.paragraphs[0].runs[0].font.size = Pt(30)
        s.shapes.title.text_frame.paragraphs[0].runs[0].font.color.rgb = accent
        body = s.placeholders[1].text_frame
        body.word_wrap = True
        first = True
        for ref in chunk:
            p = body.paragraphs[0] if first else body.add_paragraph()
            p.text = ref["text"]
            p.font.size = Pt(14)
            first = False

    buf = io.BytesIO()
    prs.save(buf)
    return buf.getvalue()


# ── PDF ────────────────────────────────────────────────────────────────────

def build_pdf(topic: str, sections: dict, papers: list[dict], synthesis: dict,
              comparison: list[dict] | None = None, year_dist: list[dict] | None = None) -> bytes:
    from reportlab.lib.pagesizes import LETTER
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import inch
    from reportlab.lib import colors
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, HRFlowable

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=LETTER, title=review_title(sections, topic),
        leftMargin=0.9 * inch, rightMargin=0.9 * inch,
        topMargin=0.85 * inch, bottomMargin=0.85 * inch,
    )
    ss = getSampleStyleSheet()
    accent = colors.Color(ACCENT[0] / 255, ACCENT[1] / 255, ACCENT[2] / 255)
    link_color = colors.Color(LINK_COLOR[0] / 255, LINK_COLOR[1] / 255, LINK_COLOR[2] / 255)
    h_title = ParagraphStyle("t", parent=ss["Title"], fontSize=19, leading=24, textColor=accent)
    h_sec = ParagraphStyle("s", parent=ss["Heading2"], fontSize=13, leading=17,
                           spaceBefore=14, spaceAfter=6, textColor=accent)
    body = ParagraphStyle("b", parent=ss["BodyText"], fontSize=10.5, leading=15.5,
                          alignment=4, spaceAfter=8)        # justified
    small = ParagraphStyle("m", parent=ss["BodyText"], fontSize=9, textColor=colors.grey)
    ref = ParagraphStyle("r", parent=body, leftIndent=18, firstLineIndent=-18, spaceAfter=4)

    def esc(t):
        return (_sanitize(t) or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    link_hex = f"{LINK_COLOR[0]:02x}{LINK_COLOR[1]:02x}{LINK_COLOR[2]:02x}"
    cite_urls = citation_urls(papers)

    def linkify(text: str) -> str:
        """Escape body text, then turn inline [n] citation markers into
        clickable links to that paper's URL (reportlab supports inline <a>
        markup directly in Paragraph text)."""
        out = []
        for seg, num in _split_citations(text):
            e = esc(seg)
            if num and cite_urls.get(num):
                safe_url = cite_urls[num].replace("&", "&amp;")
                e = f'<a href="{safe_url}" color="#{link_hex}"><u>{e}</u></a>'
            out.append(e)
        return "".join(out)

    story = [Paragraph(esc(review_title(sections, topic)), h_title)]
    story.append(Paragraph(
        f"A literature review of {len(papers)} sources · generated by Sift · {date.today().isoformat()}",
        small))
    story.append(Spacer(1, 6))
    story.append(HRFlowable(width="100%", color=accent, thickness=1))

    # This PDF mirrors the in-app Review tab exactly: the written sections,
    # then a plain reference list. No extra data table here — that lives in
    # the slide deck, where it adds real value as its own visual.
    for key, label in SECTION_ORDER:
        text = (sections or {}).get(key)
        if not text:
            continue
        story.append(Paragraph(label, h_sec))
        for p in _paras(text):
            story.append(Paragraph(linkify(p), body))

    if papers:
        story.append(Paragraph("References", h_sec))
        for r in reference_list(papers):
            story.append(Paragraph(esc(r["text"]), ref))

    doc.build(story)
    return buf.getvalue()


# ── DOCX (IEEE / arXiv templates) ──────────────────────────────────────────

def _add_hyperlink(paragraph, url: str, text: str, size_pt: int | None = None):
    """python-docx has no high-level hyperlink API — this is the standard
    OOXML recipe: register the URL as an external relationship on the part,
    then build the <w:hyperlink> run manually so it's a real clickable link
    (not just blue underlined text)."""
    from docx.oxml.ns import qn
    from docx.oxml import OxmlElement
    from docx.opc.constants import RELATIONSHIP_TYPE

    part = paragraph.part
    r_id = part.relate_to(url, RELATIONSHIP_TYPE.HYPERLINK, is_external=True)

    hyperlink = OxmlElement("w:hyperlink")
    hyperlink.set(qn("r:id"), r_id)

    new_run = OxmlElement("w:r")
    rpr = OxmlElement("w:rPr")
    color = OxmlElement("w:color")
    color.set(qn("w:val"), f"{LINK_COLOR[0]:02X}{LINK_COLOR[1]:02X}{LINK_COLOR[2]:02X}")
    rpr.append(color)
    u = OxmlElement("w:u")
    u.set(qn("w:val"), "single")
    rpr.append(u)
    if size_pt:
        sz = OxmlElement("w:sz")
        sz.set(qn("w:val"), str(size_pt * 2))
        rpr.append(sz)
    new_run.append(rpr)
    t = OxmlElement("w:t")
    t.text = text
    new_run.append(t)
    hyperlink.append(new_run)
    paragraph._p.append(hyperlink)
    return hyperlink


def build_docx(topic: str, sections: dict, papers: list[dict], synthesis: dict,
               template: str = "ieee",
               comparison: list[dict] | None = None, year_dist: list[dict] | None = None) -> bytes:
    from docx import Document
    from docx.enum.section import WD_SECTION
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.shared import Pt, Inches, RGBColor

    tpl = (template or "ieee").lower()
    doc = Document()
    title = review_title(sections, topic)

    # Page + base font per template
    sec = doc.sections[0]
    for m in ("top_margin", "bottom_margin", "left_margin", "right_margin"):
        setattr(sec, m, Inches(0.75 if tpl == "ieee" else 1.0))
    normal = doc.styles["Normal"]
    normal.font.name = "Times New Roman"
    normal.font.size = Pt(10 if tpl == "ieee" else 11)

    # ── Title block (single column, even in IEEE) ──
    t = doc.add_paragraph()
    t.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = t.add_run(title)
    run.font.size = Pt(20 if tpl == "ieee" else 17)
    run.font.bold = True

    meta = doc.add_paragraph()
    meta.alignment = WD_ALIGN_PARAGRAPH.CENTER
    mrun = meta.add_run(f"Generated by Sift · {len(papers)} sources · {date.today().isoformat()}")
    mrun.font.size = Pt(9)
    mrun.font.color.rgb = RGBColor(0x66, 0x66, 0x66)

    # IEEE is two-column from the abstract onward
    if tpl == "ieee":
        new = doc.add_section(WD_SECTION.CONTINUOUS)
        cols = new._sectPr.xpath("./w:cols")[0]
        cols.set(_qn("w:num"), "2")
        cols.set(_qn("w:space"), "360")          # ~0.25"
        for m in ("top_margin", "bottom_margin", "left_margin", "right_margin"):
            setattr(new, m, Inches(0.75))

    def heading(text, n=1):
        h = doc.add_paragraph()
        r = h.add_run(text.upper() if tpl == "ieee" else text)
        r.font.bold = True
        r.font.size = Pt(10 if tpl == "ieee" else 13)
        if tpl == "ieee":
            h.alignment = WD_ALIGN_PARAGRAPH.CENTER
        h.paragraph_format.space_before = Pt(10)
        h.paragraph_format.space_after = Pt(4)

    cite_urls = citation_urls(papers)

    def para(text, italic=False, bold_lead=None, linkify=False):
        p = doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
        p.paragraph_format.first_line_indent = Inches(0.2 if tpl == "ieee" else 0)
        p.paragraph_format.space_after = Pt(6)
        if bold_lead:
            b = p.add_run(bold_lead)
            b.font.bold = True
            b.font.italic = True
        clean = _sanitize(text)
        if linkify:
            # Turn inline [n] citation markers into real hyperlinks to that
            # paper's URL; everything else is one plain italic-matching run.
            for seg, num in _split_citations(clean):
                if num and cite_urls.get(num):
                    _add_hyperlink(p, cite_urls[num], seg)
                else:
                    r = p.add_run(seg)
                    r.font.italic = italic
        else:
            r = p.add_run(clean)
            r.font.italic = italic
        return p

    # ── Abstract ──
    if sections.get("abstract"):
        for i, blk in enumerate(_paras(sections["abstract"])):
            para(blk, italic=(tpl == "ieee"), bold_lead="Abstract— " if (tpl == "ieee" and i == 0) else None)

    # Index terms (IEEE convention) from synthesis themes
    themes = [_sanitize(t) for t in ((synthesis or {}).get("themes") or [])][:5]
    if themes and tpl == "ieee":
        para(", ".join(themes) + ".", italic=True, bold_lead="Index Terms— ")

    # ── Body sections ──
    numbered = ["I.", "II.", "III.", "IV.", "V.", "VI."]
    n = 0
    for key, label in SECTION_ORDER:
        if key == "abstract" or not sections.get(key):
            continue
        prefix = f"{numbered[n]} " if (tpl == "ieee" and n < len(numbered)) else ""
        heading(prefix + label)
        n += 1
        for blk in _paras(sections[key]):
            para(blk, linkify=True)

    # ── Data: comparison table ──
    if comparison:
        heading(f"{numbered[n]} Paper Comparison" if (tpl == "ieee" and n < len(numbered)) else "Paper Comparison")
        n += 1
        tbl = doc.add_table(rows=1, cols=5)
        tbl.style = "Light Grid Accent 1" if "Light Grid Accent 1" in [s.name for s in doc.styles] else "Table Grid"
        hdr = tbl.rows[0].cells
        for c, label in enumerate(["#", "Paper", "Year", "Method", "Key finding"]):
            hdr[c].text = label
            for p in hdr[c].paragraphs:
                for r in p.runs:
                    r.font.bold = True
                    r.font.size = Pt(8)
        for i, row in enumerate(comparison, 1):
            cells = tbl.add_row().cells
            vals = [str(i), _sanitize(row.get("title"))[:120], str(row.get("year") or "—"),
                    _sanitize(row.get("method"))[:80] or "—", _sanitize(row.get("finding"))[:100] or "—"]
            for c, v in enumerate(vals):
                cells[c].text = v
                for p in cells[c].paragraphs:
                    for r in p.runs:
                        r.font.size = Pt(8)

    # ── References — plain, standard bibliographic text (not hyperlinked;
    # the inline [n] markers in the body sections above carry the links) ──
    if papers:
        heading(f"{numbered[n]} References" if (tpl == "ieee" and n < len(numbered)) else "References")
        for r in reference_list(papers):
            p = doc.add_paragraph()
            p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
            p.paragraph_format.left_indent = Inches(0.25)
            p.paragraph_format.first_line_indent = Inches(-0.25)
            p.paragraph_format.space_after = Pt(3)
            size = 8.5 if tpl == "ieee" else 10
            run = p.add_run(r["text"])
            run.font.size = Pt(size)

    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


def _qn(tag: str):
    from docx.oxml.ns import qn
    return qn(tag)
