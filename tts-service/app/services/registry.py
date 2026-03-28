from typing import Optional

from app.services.base import TTSProvider


class ProviderRegistry:
    def __init__(self) -> None:
        self._providers: dict = {}
        self._default: str = ""

    def register(self, name: str, provider: TTSProvider) -> None:
        self._providers[name] = provider
        if not self._default:
            self._default = name

    def get(self, name: Optional[str] = None) -> TTSProvider:
        key = name or self._default
        if key not in self._providers:
            raise KeyError(f"Provider '{key}' not found in registry")
        return self._providers[key]
