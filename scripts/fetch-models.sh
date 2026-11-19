#!/usr/bin/env bash
# Kokoro (Apache-2.0) model files for the local voice worker: ~350 MB, once.
set -euo pipefail
d="${KOKORO_DIR:-$HOME/.cache/tohn-models}"; mkdir -p "$d"
for f in kokoro-v1.0.onnx voices-v1.0.bin; do
  [ -s "$d/$f" ] || curl -fL -o "$d/$f" "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/$f"
done
echo "models in $d"
