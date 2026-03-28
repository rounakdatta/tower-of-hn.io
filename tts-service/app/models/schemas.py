from pydantic import BaseModel, Field


class SynthesizeRequest(BaseModel):
    text: str
    voice_id: str = Field(default="af_heart")
    speed: float = Field(default=1.0)
    format: str = Field(default="wav")


class VoiceInfo(BaseModel):
    id: str
    gender: str
    language: str
