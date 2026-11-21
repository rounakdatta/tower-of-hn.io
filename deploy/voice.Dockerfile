# syntax=docker/dockerfile:1.7
# TowerOfHan voices: Kokoro (ONNX, fp16 weights), a permanent voice per HN user. One CPU thread in the
# background; three, within a budget, while someone listens. The models are baked in (checksummed).
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 OMP_NUM_THREADS=1 KOKORO_DIR=/models
COPY apps/voice-worker/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt
ADD --checksum=sha256:c1610a859f3bdea01107e73e50100685af38fff88f5cd8e5c56df109ec880204 \
    https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.fp16.onnx /models/kokoro-v1.0.fp16.onnx
ADD --checksum=sha256:bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d \
    https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin /models/voices-v1.0.bin
RUN chmod 0644 /models/*
COPY apps/voice-worker/worker.py /app/worker.py
USER 1000:1000
CMD ["python", "/app/worker.py", "/data"]
