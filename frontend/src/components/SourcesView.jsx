import React from "react";

export default function SourcesView({ citeOrder, extractions }) {
  const extByIdx = {};
  (extractions || []).forEach((e) => (extByIdx[e.idx] = e));

  return (
    <div>
      {citeOrder.map((p, i) => {
        const e = extByIdx[p.idx];
        return (
          <div key={p.idx} className="paper">
            <div className="paper-top">
              <span className="cite">[{i + 1}]</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="paper-title">{p.title}</div>
                <div className="paper-meta">
                  {p.authors} · {p.year} · {p.venue || "preprint"}
                  {p.url && <> · <a href={p.url} target="_blank" rel="noreferrer">link</a></>}
                </div>
                {e && (
                  <div style={{ marginTop: 9 }}>
                    <div className="kv"><span className="k">Method</span><span className="v">{e.method}</span></div>
                    <div className="kv"><span className="k">Finding</span><span className="v">{e.finding}</span></div>
                    <div className="kv"><span className="k">Limitation</span><span className="v">{e.limitation}</span></div>
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
