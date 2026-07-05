"""
Pydantic models describing the shapes that flow between agents.
These double as request/response validation at the API boundary.
"""
from typing import Optional

from pydantic import BaseModel, Field


class Reformulation(BaseModel):
    queries: list[str] = Field(default_factory=list)
    terms: list[str] = Field(default_factory=list)
    scope: Optional[str] = None


class Paper(BaseModel):
    idx: int
    title: str
    authors: Optional[str] = None
    year: Optional[int] = None
    venue: Optional[str] = None
    url: Optional[str] = None
    abstract: Optional[str] = None


class Extraction(BaseModel):
    idx: int
    method: Optional[str] = None
    finding: Optional[str] = None
    data: Optional[str] = None
    limitation: Optional[str] = None
    concepts: list[str] = Field(default_factory=list)


class RankedPaper(BaseModel):
    idx: int
    score: int
    reason: Optional[str] = None


class Synthesis(BaseModel):
    themes: list[str] = Field(default_factory=list)
    consensus: Optional[str] = None
    tensions: Optional[str] = None
    gaps: list[str] = Field(default_factory=list)
    biases: list[str] = Field(default_factory=list)
    ranked: list[RankedPaper] = Field(default_factory=list)


class ReviewSections(BaseModel):
    intro: str = ""
    synthesis: str = ""
    gaps: str = ""
    future: str = ""


class EvalResult(BaseModel):
    scores: dict[str, int] = Field(default_factory=dict)
    overall: int = 0
    notes: Optional[str] = None


class ConceptNode(BaseModel):
    label: str
    papers: list[int]


class YearBucket(BaseModel):
    year: str
    count: int


class ComparisonRow(BaseModel):
    idx: int
    title: str
    year: Optional[int] = None
    method: Optional[str] = None
    finding: Optional[str] = None
    score: Optional[int] = None
