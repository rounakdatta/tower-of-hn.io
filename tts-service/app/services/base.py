from abc import ABC, abstractmethod


class TTSProvider(ABC):
    @abstractmethod
    async def synthesize(self, text: str, voice_id: str, speed: float) -> tuple[bytes, int]:
        """Synthesize text to audio.

        Returns a tuple of (audio_bytes, duration_ms).
        """
        ...

    @abstractmethod
    def list_voices(self) -> list[dict]:
        """Return the list of available voices."""
        ...

    @abstractmethod
    def health_check(self) -> bool:
        """Return True if the provider is healthy and ready."""
        ...
