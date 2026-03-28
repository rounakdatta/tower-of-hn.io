import io
import logging
import asyncio

import numpy as np
import soundfile as sf
import edge_tts

from app.services.base import TTSProvider

logger = logging.getLogger(__name__)

SAMPLE_RATE = 24000

# Map our voice IDs to currently available edge-tts voices.
# These are verified working as of March 2026.
VOICE_MAP = {
    "af_heart": "en-US-AvaNeural",
    "af_bella": "en-US-EmmaNeural",
    "af_nicole": "en-AU-NatashaNeural",
    "af_sarah": "en-CA-ClaraNeural",
    "af_sky": "en-NZ-MollyNeural",
    "am_fenrir": "en-US-AndrewNeural",
    "am_michael": "en-US-BrianNeural",
    "am_puck": "en-AU-WilliamMultilingualNeural",
    "am_eric": "en-CA-LiamNeural",
    "am_adam": "en-IN-PrabhatNeural",
    "bf_emma": "en-GB-LibbyNeural",
    "bf_isabella": "en-IE-EmilyNeural",
    "bm_george": "en-GB-RyanNeural",
    "bm_fable": "en-IE-ConnorNeural",
}

DEFAULT_VOICE = "en-US-BrianNeural"

VOICE_POOL = [
    {"id": k, "gender": "female" if k.startswith(("af_", "bf_")) else "male",
     "language": "en-gb" if k.startswith("b") else "en-us"}
    for k in VOICE_MAP
]


class EdgeTTSProvider(TTSProvider):
    """TTS provider using Microsoft Edge's free TTS service."""

    def __init__(self):
        self._available = True
        logger.info("Edge TTS provider initialized")

    async def synthesize(self, text: str, voice_id: str, speed: float) -> tuple:
        edge_voice = VOICE_MAP.get(voice_id, DEFAULT_VOICE)

        # Truncate very long texts
        if len(text) > 3000:
            text = text[:3000] + "..."

        # Build rate string
        rate_pct = int((speed - 1.0) * 100)
        rate_str = f"{rate_pct:+d}%"

        try:
            audio_data = await self._generate(text, edge_voice, rate_str)
        except Exception as e:
            # Fallback to default voice if specific voice fails
            logger.warning("Voice %s failed (%s), falling back to %s", edge_voice, e, DEFAULT_VOICE)
            if edge_voice != DEFAULT_VOICE:
                audio_data = await self._generate(text, DEFAULT_VOICE, rate_str)
            else:
                raise

        return audio_data

    async def _generate(self, text: str, voice: str, rate: str) -> tuple:
        communicate = edge_tts.Communicate(text, voice, rate=rate)
        audio_chunks = []
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                audio_chunks.append(chunk["data"])

        if not audio_chunks:
            raise RuntimeError(f"Edge TTS produced no audio for voice {voice}")

        mp3_data = b"".join(audio_chunks)

        # Convert MP3 to 16-bit WAV
        audio_array, sr = sf.read(io.BytesIO(mp3_data))
        if len(audio_array.shape) > 1:
            audio_array = audio_array.mean(axis=1)

        buf = io.BytesIO()
        sf.write(buf, audio_array, sr, format="WAV", subtype="PCM_16")
        wav_bytes = buf.getvalue()
        duration_ms = int(len(audio_array) / sr * 1000)

        return wav_bytes, duration_ms

    def list_voices(self) -> list:
        return VOICE_POOL

    def health_check(self) -> bool:
        return self._available
