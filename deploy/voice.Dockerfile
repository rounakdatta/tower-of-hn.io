# syntax=docker/dockerfile:1.7
# TowerOfHan voices: Kokoro (ONNX) on one CPU thread, a permanent voice per HN user.
# The models are baked in (checksummed), so a restart never re-downloads 350 MB.
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 OMP_NUM_THREADS=1 KOKORO_DIR=/models
COPY apps/voice-worker/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt
ADD --checksum=sha256:7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5 \
    https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx /models/kokoro-v1.0.onnx
ADD --checksum=sha256:bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d \
    https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin /models/voices-v1.0.bin
RUN chmod 0644 /models/*
COPY apps/voice-worker/worker.py /app/worker.py
USER 1000:1000
CMD ["python", "/app/worker.py", "/data"]
