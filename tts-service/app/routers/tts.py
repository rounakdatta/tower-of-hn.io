from typing import Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from app.models.schemas import SynthesizeRequest
from app.services.registry import ProviderRegistry

router = APIRouter()

registry: Optional[ProviderRegistry] = None


def set_registry(reg: ProviderRegistry) -> None:
    global registry
    registry = reg


def _get_provider():
    if registry is None:
        raise HTTPException(status_code=503, detail="TTS service not initialized")
    return registry.get()


@router.post("/synthesize")
async def synthesize(request: SynthesizeRequest):
    provider = _get_provider()
    try:
        audio_bytes, duration_ms = await provider.synthesize(
            text=request.text,
            voice_id=request.voice_id,
            speed=request.speed,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    return Response(
        content=audio_bytes,
        media_type="audio/wav",
        headers={
            "X-Duration-Ms": str(duration_ms),
            "X-Sample-Rate": "24000",
        },
    )


@router.get("/voices")
async def list_voices():
    provider = _get_provider()
    return provider.list_voices()


@router.get("/health")
async def health():
    provider = _get_provider()
    healthy = provider.health_check()
    status = "ok" if healthy else "degraded"
    return {"status": status, "provider": "kokoro"}
