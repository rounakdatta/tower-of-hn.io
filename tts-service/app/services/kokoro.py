import io
import logging

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
    {"id": "af_kore", "gender": "female", "language": "en-us"},
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


class KokoroProvider(TTSProvider):
    def __init__(self, lang_code: str = "a"):
        self._pipeline = None
        self._available = False

        try:
            from kokoro import KPipeline

            self._pipeline = KPipeline(lang_code=lang_code)
            self._available = True
            logger.info("Kokoro TTS pipeline initialized successfully")
        except Exception as exc:
            logger.error("Failed to initialize Kokoro TTS pipeline: %s", exc)

    async def synthesize(self, text: str, voice_id: str, speed: float) -> tuple[bytes, int]:
        if not self._available or self._pipeline is None:
            raise RuntimeError("Kokoro TTS pipeline is not available")

        audio_segments: list[np.ndarray] = []

        for result in self._pipeline(text, voice=voice_id, speed=speed):
            if result.audio is not None:
                audio_segments.append(result.audio)

        if not audio_segments:
            raise RuntimeError("Kokoro produced no audio output")

        audio = np.concatenate(audio_segments)

        buf = io.BytesIO()
        sf.write(buf, audio, SAMPLE_RATE, format="WAV")
        wav_bytes = buf.getvalue()

        duration_ms = int(len(audio) / SAMPLE_RATE * 1000)

        return wav_bytes, duration_ms

    def list_voices(self) -> list[dict]:
        return VOICE_POOL

    def health_check(self) -> bool:
        return self._available
