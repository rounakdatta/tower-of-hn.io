import io
import logging
import asyncio

import numpy as np
import soundfile as sf
import edge_tts

from app.services.base import TTSProvider

logger = logging.getLogger(__name__)

SAMPLE_RATE = 24000

# Map our voice IDs to edge-tts voice names.
# These are diverse, natural-sounding voices.
VOICE_MAP = {
    "af_heart": "en-US-AvaMultilingualNeural",
    "af_bella": "en-US-JennyNeural",
    "af_nicole": "en-US-AriaNeural",
    "af_sarah": "en-US-SaraNeural",
    "af_sky": "en-US-AnaNeural",
    "am_fenrir": "en-US-GuyNeural",
    "am_michael": "en-US-ChristopherNeural",
    "am_puck": "en-US-EricNeural",
    "am_eric": "en-US-RogerNeural",
    "am_adam": "en-US-SteffanNeural",
    "bf_emma": "en-GB-SoniaNeural",
    "bf_isabella": "en-GB-MaisieNeural",
    "bm_george": "en-GB-RyanNeural",
    "bm_fable": "en-GB-ThomasNeural",
}

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
        # Map our voice ID to edge-tts voice name
        edge_voice = VOICE_MAP.get(voice_id, "en-US-GuyNeural")

        # Truncate very long texts
        if len(text) > 3000:
            text = text[:3000] + "..."

        # Build rate string (e.g., "+0%", "+20%", "-10%")
        rate_pct = int((speed - 1.0) * 100)
        rate_str = f"{rate_pct:+d}%"

        communicate = edge_tts.Communicate(text, edge_voice, rate=rate_str)

        # Collect audio chunks
        audio_chunks = []
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                audio_chunks.append(chunk["data"])

        if not audio_chunks:
            raise RuntimeError(f"Edge TTS produced no audio for voice {edge_voice}")

        mp3_data = b"".join(audio_chunks)

        # Edge TTS returns MP3 — convert to WAV for consistency
        # Use soundfile to read the MP3 and re-encode as WAV
        try:
            audio_array, sr = sf.read(io.BytesIO(mp3_data))

            # Resample to 24kHz mono if needed
            if len(audio_array.shape) > 1:
                audio_array = audio_array.mean(axis=1)  # stereo to mono

            # Write as 16-bit WAV
            buf = io.BytesIO()
            sf.write(buf, audio_array, sr, format="WAV", subtype="PCM_16")
            wav_bytes = buf.getvalue()

            duration_ms = int(len(audio_array) / sr * 1000)
            return wav_bytes, duration_ms

        except Exception as e:
            # If soundfile can't read MP3, return raw MP3 with estimated duration
            logger.warning("Could not convert MP3 to WAV: %s, returning MP3", e)
            # Rough estimate: MP3 at 48kbps
            duration_ms = int(len(mp3_data) / 6000 * 1000)
            return mp3_data, duration_ms

    def list_voices(self) -> list:
        return VOICE_POOL

    def health_check(self) -> bool:
        return self._available
