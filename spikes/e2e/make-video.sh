#!/usr/bin/env bash
# Record the e2e demo with sound: serve the spike + voiced data, capture frames, mux real clips.
# usage: make-video.sh <seconds at the table> <out.mp4>
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
secs="${1:-55}"; out="${2:-$here/../../docs/img/e2e.mp4}"
cd "$here/../tower3d"
npx vite build >/dev/null 2>&1
rm -rf dist/data && cp -r "$here/data" dist/data
frames=/tmp/tohn/e2e-frames
rm -rf "$frames"
node "$here/record.cjs" "$frames" "$secs" 2>&1 | grep -v -E "dbus|machine-id|OOM" || true
source ~/.cache/tohn-venv/bin/activate
export LD_LIBRARY_PATH="$(cat ~/.cache/tohn-ldpath)"
nix --extra-experimental-features 'nix-command flakes' shell nixpkgs#ffmpeg -c python "$here/mux.py" "$frames" "$here/data" "$out"
