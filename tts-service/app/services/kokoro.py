import io
import logging
import asyncio
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import soundfile as sf

from app.services.base import TTSProvider

logger = logging.getLogger(__name__)

SAMPLE_RATE = 24000

VOICE_POOL = [
    {"id": "af_heart", "gender": "female", "language": "en-us"},
    {"id": "af_bella", "gender": "female", "language": "en-us"},
    {"id": "af_nicole", "gender": "female", "language": "en-us"},
    {"id": "af_sarah", "gender": "female", "language": "en-us"},
    {"id": "af_sky", "gender": "female", "language": "en-us"},
    {"id": "am_fenrir", "gender": "male", "language": "en-us"},
    {"id": "am_michael", "gender": "male", "language": "en-us"},
    {"id": "am_puck", "gender": "male", "language": "en-us"},
    {"id": "am_eric", "gender": "male", "language": "en-us"},
    {"id": "am_adam", "gender": "male", "language": "en-us"},
    {"id": "bf_emma", "gender": "female", "language": "en-gb"},
    {"id": "bf_isabella", "gender": "female", "language": "en-gb"},
    {"id": "bm_george", "gender": "male", "language": "en-gb"},
    {"id": "bm_fable", "gender": "male", "language": "en-gb"},
]

# Thread pool for CPU-bound TTS work
_executor = ThreadPoolExecutor(max_workers=2)


class KokoroProvider(TTSProvider):
    def __init__(self, lang_code: str = "a"):
        self._kokoro = None
        self._available = False

        try:
            from kokoro_onnx import Kokoro

            self._kokoro = Kokoro(
                "kokoro-v1.0.onnx",
                "voices-v1.0.bin",
            )
            self._available = True
            logger.info("Kokoro ONNX TTS initialized successfully")
        except Exception as exc:
            logger.error("Failed to initialize Kokoro ONNX: %s", exc)
            logger.info(
                "To download models, run: pip install huggingface_hub && "
                "huggingface-cli download hexgrad/Kokoro-ONNX-v1.0 --local-dir . --include '*.onnx' '*.bin'"
            )

    def _synthesize_sync(self, text: str, voice_id: str, speed: float) -> tuple[bytes, int]:
        """Synchronous TTS — runs in thread pool since ONNX inference is CPU-bound."""
        if not self._available or self._kokoro is None:
            raise RuntimeError("Kokoro ONNX is not available")

        # Truncate very long texts to avoid excessive generation times
        if len(text) > 2000:
            text = text[:2000] + "..."

        audio, sample_rate = self._kokoro.create(
            text,
            voice=voice_id,
            speed=speed,
        )

        if audio is None or len(audio) == 0:
            raise RuntimeError("Kokoro produced no audio output")

        # Convert to WAV bytes
        buf = io.BytesIO()
        sf.write(buf, audio, sample_rate, format="WAV", subtype="PCM_16")
        wav_bytes = buf.getvalue()

        duration_ms = int(len(audio) / sample_rate * 1000)
        return wav_bytes, duration_ms

    async def synthesize(self, text: str, voice_id: str, speed: float) -> tuple[bytes, int]:
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(
            _executor,
            self._synthesize_sync,
            text, voice_id, speed,
        )

    def list_voices(self) -> list[dict]:
        return VOICE_POOL

    def health_check(self) -> bool:
        return self._available
