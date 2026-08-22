import React, { useMemo } from "react";
import katex from "katex";

/**
 * Renders plain text that may contain inline ($...$) or display ($$...$$)
 * LaTeX math — the shape abstracts pulled from arXiv/Semantic Scholar often
 * come in (e.g. "reduces noise by $18.44 \\text{dB}$"). Everything outside
 * $...$/$$...$$ is shown as normal text; math segments are typeset with
 * KaTeX. Falls back to the raw source for a segment that fails to parse
 * (malformed LaTeX in an abstract shouldn't blank out the whole excerpt).
 *
 * Not a general markdown renderer — just math-aware plain text, since that's
 * all abstract/excerpt/finding cells need.
 */
export default function MathText({ text, className }) {
  const parts = useMemo(() => splitMath(text == null ? "" : String(text)), [text]);
  if (parts.length === 1 && parts[0].type === "text") return <>{parts[0].value}</>;
  return (
    <span className={className}>
      {parts.map((p, i) =>
        p.type === "text" ? (
          <React.Fragment key={i}>{p.value}</React.Fragment>
        ) : (
          <MathSpan key={i} src={p.value} display={p.display} />
        )
      )}
    </span>
  );
}

function MathSpan({ src, display }) {
  const html = useMemo(() => {
    try {
      return katex.renderToString(src, {
        throwOnError: false,
        displayMode: !!display,
        strict: "ignore",
      });
    } catch {
      return null;
    }
  }, [src, display]);
  if (html == null) {
    // Malformed LaTeX — show the original source (with delimiters) rather
    // than silently dropping it.
    return <>{display ? `$$${src}$$` : `$${src}$`}</>;
  }
  // eslint-disable-next-line react/no-danger -- KaTeX's own output, not user HTML
  return <span dangerouslySetInnerHTML={{ __html: html }} />;
}

// Splits on $$...$$ (display) and $...$ (inline), left-to-right, non-greedy,
// skipping empty math ("$$" used as a literal in some abstracts) and never
// crossing a newline for inline math (real inline math doesn't span lines;
// treating a stray "$" as a delimiter across a whole paragraph is worse than
// leaving it literal).
function splitMath(text) {
  const parts = [];
  const re = /\$\$([^$]+?)\$\$|\$([^$\n]+?)\$/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push({ type: "text", value: text.slice(last, m.index) });
    if (m[1] != null) parts.push({ type: "math", value: m[1], display: true });
    else parts.push({ type: "math", value: m[2], display: false });
    last = re.lastIndex;
  }
  if (last < text.length) parts.push({ type: "text", value: text.slice(last) });
  if (parts.length === 0) parts.push({ type: "text", value: "" });
  return parts;
}
