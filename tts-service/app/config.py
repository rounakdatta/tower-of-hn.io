from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    kokoro_lang_code: str = "a"
    device: str = "cpu"
    max_workers: int = 2
