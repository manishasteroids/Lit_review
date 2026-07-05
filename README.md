# Saṃhitā — multi-agent literature review pipeline

A real implementation of the pipeline diagram: a FastAPI backend with one
file per agent, and a React frontend that drives it stage by stage.

```
samhita/
├── backend/                     FastAPI app — the agent pipeline
│   ├── main.py                  entrypoint (uvicorn main:app)
│   ├── core/
│   │   ├── config.py            settings (reads ANTHROPIC_API_KEY etc.)
│   │   ├── llm_client.py        shared Claude call + JSON-parsing helper
│   │   └── models.py            pydantic schemas shared across agents
│   ├── agents/                  one file per box in the diagram
│   │   ├── query_reformulator.py
│   │   ├── academic_search.py
│   │   ├── paper_filter.py      (human-in-the-loop, no LLM call)
│   │   ├── reader_extractor.py
│   │   ├── critic_synthesizer.py
│   │   ├── writer.py
│   │   └── evaluator.py         answers the "how to evaluate output?" open question
│   ├── pipeline/
│   │   ├── orchestrator.py      wires agents together, holds run state
│   │   ├── knowledge_graph.py   side module: concept graph
│   │   └── data_analysis.py     side module: year chart + comparison table
│   └── api/routes.py            one endpoint per pipeline stage
│
└── frontend/                    React (Vite) — talks to the backend only
    └── src/
        ├── App.jsx              top-level orchestration of stage calls
        ├── api/client.js        the only file that knows backend URLs
        └── components/          one component per pipeline view
            ├── PipelineRail.jsx
            ├── QueryInput.jsx
            ├── PaperFilter.jsx
            ├── ReviewView.jsx
            ├── SourcesView.jsx
            ├── CritiqueView.jsx
            ├── KnowledgeGraphView.jsx
            ├── DataAnalysisView.jsx
            └── EvaluationView.jsx
```

## Why split it up this way

The previous version was a single React artifact that called the Anthropic
API directly from the browser — fine for a demo, but it meant your API key
lived in client-side JS. Here the key stays server-side in `backend/`, and
the frontend only ever talks to your own FastAPI server. Each diagram box
also becomes its own file, so you can swap any one stage (e.g. point
`academic_search.py` at the real arXiv API, or back `knowledge_graph.py`
with Neo4j) without touching anything else.

## Run it

**Backend**
```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # then put your ANTHROPIC_API_KEY in .env
uvicorn main:app --reload --port 8000
```

**Frontend** (separate terminal)
```bash
cd frontend
npm install
cp .env.example .env        # defaults to http://localhost:8000, fine as-is
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173`).

## Notes

- Run state lives in memory (`pipeline/orchestrator.py: RUNS`), so it resets
  if you restart the backend. Swap it for Redis/Postgres to persist runs.
- Academic Search uses Claude's `web_search` tool, which needs to be enabled
  on your Anthropic key. If it isn't, `agents/academic_search.py` has a note
  on swapping in the real arXiv API instead.
- The Evaluation tab is one answer to the diagram's open question about
  judging review quality — a rubric self-critique. It's a separate agent
  on purpose, so a "revise weak sections" loop can be added later without
  touching the Writer Agent.
- The Model Layer chips in the header are wired to swap between Claude
  models; GPT-5/Gemini are shown for parity with the diagram but aren't
  implemented (the backend only has an Anthropic client).
# Lit_review
# Lit_review
