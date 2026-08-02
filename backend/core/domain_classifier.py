"""
Domain classifier — decides whether a research topic falls inside a
pre-indexed domain (currently: biomedical) or should go straight to live
multi-source search.

Two layers, cheapest first:
  1. The Query Reformulator's own LLM call already classifies the topic as
     part of its normal (free-tier Gemini) output — see agents/query_reformulator.py.
  2. This module is the free, zero-LLM backstop: if that field is missing or
     malformed, fall back to keyword overlap against a curated biomedical
     vocabulary. It's deliberately small and swappable — a real deployment
     should replace `_BIOMED_TERMS` with NIH's full MeSH term list (free,
     public, downloadable), which is a drop-in replacement for this set.
"""
import re

DOMAINS = ("biomedical", "other")
DEFAULT_DOMAIN = "other"

# A small, representative slice of biomedical/life-science vocabulary —
# enough to catch the common case cheaply. Swap in the full MeSH descriptor
# list (https://www.nlm.nih.gov/mesh/) for production-grade coverage.
_BIOMED_TERMS = {
    "gene", "genes", "genome", "genomic", "genomics", "genetic", "genetics",
    "dna", "rna", "mrna", "protein", "proteins", "proteomics", "enzyme",
    "cell", "cells", "cellular", "tissue", "organism", "microbiome",
    "disease", "diseases", "disorder", "syndrome", "cancer", "tumor",
    "oncology", "carcinoma", "metastasis", "diabetes", "cardiovascular",
    "neurological", "neuroscience", "immune", "immunology", "immunotherapy",
    "antibody", "antibodies", "antigen", "vaccine", "vaccination",
    "pathogen", "virus", "viral", "bacteria", "bacterial", "infection",
    "clinical", "patient", "patients", "cohort", "trial", "randomized",
    "diagnosis", "diagnostic", "prognosis", "therapeutic", "therapy",
    "treatment", "drug", "drugs", "pharmacology", "pharmaceutical",
    "pharmacokinetics", "dosage", "compound", "molecule", "molecular",
    "biomarker", "biomarkers", "assay", "biopsy", "histology",
    "crispr", "sequencing", "transcriptome", "epigenetic", "epigenetics",
    "mutation", "mutations", "variant", "allele", "chromosome",
    "receptor", "ligand", "pathway", "metabolism", "metabolic",
    "physiology", "anatomy", "surgical", "surgery", "medicine", "medical",
    "biomedical", "biotechnology", "biotech", "bioinformatics",
    "pubmed", "biorxiv", "in vivo", "in vitro", "rodent", "mouse model",
}

_WORD_RE = re.compile(r"[a-z][a-z\-]{2,}")


def classify_domain(*texts: str) -> str:
    """Free, deterministic domain guess from plain keyword overlap. Used as a
    fallback when the LLM-provided `domain` field is missing/invalid — never
    the primary signal when the LLM one is available."""
    blob = " ".join(t or "" for t in texts).lower()
    words = set(_WORD_RE.findall(blob))
    hits = words & _BIOMED_TERMS
    # a couple of unambiguous multi-word terms wouldn't be caught by the
    # single-token overlap above
    for phrase in ("in vivo", "in vitro", "mouse model"):
        if phrase in blob:
            hits.add(phrase)
    return "biomedical" if hits else DEFAULT_DOMAIN


def normalize_domain(value: str | None, *fallback_texts: str) -> str:
    """Validate an LLM-provided domain value; fall back to the free keyword
    classifier if it's missing or not one of the known labels."""
    v = (value or "").strip().lower()
    if v in DOMAINS:
        return v
    return classify_domain(*fallback_texts)
