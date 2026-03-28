import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routers import tts
from app.services.registry import ProviderRegistry

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Initializing TTS service...")

    registry = ProviderRegistry()

    # Try Kokoro first, fall back to Edge TTS
    try:
        from app.services.kokoro import KokoroProvider
        provider = KokoroProvider()
        if provider.health_check():
            registry.register("kokoro", provider)
            logger.info("Using Kokoro TTS provider")
        else:
            raise RuntimeError("Kokoro not healthy")
    except Exception as exc:
        logger.info("Kokoro not available (%s), using Edge TTS", exc)
        from app.services.edge import EdgeTTSProvider
        provider = EdgeTTSProvider()
        registry.register("edge", provider)
        logger.info("Using Edge TTS provider")

    tts.set_registry(registry)

    yield

    logger.info("TTS service shutting down")


app = FastAPI(title="Tower of HN - TTS Service", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(tts.router)
