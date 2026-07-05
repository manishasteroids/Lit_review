from abc import ABC, abstractmethod

from core.llm_client import LLMClient


class Agent(ABC):
    """Every LLM-backed pipeline node implements this."""

    name: str = "agent"

    def __init__(self, llm: LLMClient):
        self.llm = llm

    @abstractmethod
    def run(self, *args, **kwargs):
        ...
