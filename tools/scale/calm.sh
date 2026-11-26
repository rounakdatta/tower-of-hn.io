#!/bin/bash
# exits when kanmani's 5-minute load has stayed under $1 for 5 checks in a row (one a minute), or after $2 minutes
lim=$1; mins=$2; ok=0; end=$(( $(date +%s) + mins * 60 ))
while [ "$(date +%s)" -lt "$end" ]; do
  l5=$(awk '{print $2}' /proc/loadavg)
  if awk -v l="$l5" -v m="$lim" 'BEGIN{exit !(l < m)}'; then ok=$((ok+1)); else ok=0; fi
  [ $ok -ge 5 ] && { echo "calm $(date +%H:%M) load5 $l5"; exit 0; }
  sleep 60
done
echo "no calm window in ${mins} min (last load5 $l5)"; exit 1
