#!/bin/bash
# Every 2 minutes: towerd's voicing coverage and lanes (one in-cluster GET), appended to a JSONL file. Light by design.
# usage: cover_watch.sh OUT.jsonl [MINUTES=240]
out=$1; mins=${2:-240}
end=$(( $(date +%s) + mins * 60 ))
while [ "$(date +%s)" -lt "$end" ]; do
  curl -s -m 8 http://towerofhan.apps.svc.cluster.local:8787/status \
    | jq -c --arg t "$(date +%s)" '{t: ($t|tonumber), cover, listeners, backlog, voicing: {ahead: .voicing.ahead, lanes: .voicing.lanes, nodes: .voicing.nodes, rtf: .voicing.rtf, queued: .voicing.queued, held: .voicing.held}, audio: {mb: .audio.mb, free_pct: .audio.free_pct, missing: .audio.gets.missing}}' >> "$out" 2>/dev/null
  sleep 120
done
