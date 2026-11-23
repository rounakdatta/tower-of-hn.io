# syntax=docker/dockerfile:1.7
# TowerOfHan voices: Kokoro (ONNX, fp16 weights), a permanent voice per HN user. A runner: lanes of Kokoro that claim
# comments from towerd's voice port and send the clips back (no volume, no keys, no internet). The models are baked
# in (checksummed).
# Layers go from the steadiest to the most changed, and CI caches them in the registry, so a release ships only what
# changed: the models (~200 MB, readable as they land: no second copy for a chmod), then the Python packages, then the
# runner itself (a few KB). A worker on a slow link pulls kilobytes, not the whole image.
# The base is pinned by digest: a floating tag changes upstream without a commit, and every layer after it would come
# out new (bump it on purpose).
FROM python:3.12-slim@sha256:5e2bdb1b0d542d5039cffb8181c65930093949194a65c365dfb1b0fe13a4fa5b
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 OMP_NUM_THREADS=1 KOKORO_DIR=/models
ADD --link --chmod=0644 --checksum=sha256:c1610a859f3bdea01107e73e50100685af38fff88f5cd8e5c56df109ec880204 \
    https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.fp16.onnx /models/kokoro-v1.0.fp16.onnx
ADD --link --chmod=0644 --checksum=sha256:bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d \
    https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin /models/voices-v1.0.bin
COPY apps/voice-worker/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt
COPY apps/voice-worker/worker.py /app/worker.py
USER 1000:1000
CMD ["python", "/app/worker.py"]
