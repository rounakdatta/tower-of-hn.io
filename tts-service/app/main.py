import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import Settings
from app.routers import tts
from app.services.kokoro import KokoroProvider
from app.services.registry import ProviderRegistry

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

settings = Settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Initializing TTS service...")

    registry = ProviderRegistry()
    provider = KokoroProvider(lang_code=settings.kokoro_lang_code)
    registry.register("kokoro", provider)

    tts.set_registry(registry)

    if provider.health_check():
        logger.info("Kokoro TTS provider is ready")
    else:
        logger.warning("Kokoro TTS provider failed to initialize")

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
