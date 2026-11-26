#!/bin/bash
# Run one heavy step the careful way (the brief's rule 4): refuse if the box is busy, then nice 10 + ionice idle-ish,
# under a time limit, with a memory watchdog over the whole process tree (kills it past MEM_MB).
# usage: heavy.sh SECONDS MEM_MB cmd args...
H=$(dirname "$(readlink -f "$0")")
# ionice and setsid (util-linux): from PATH, else beside this script (a symlink into the nix store on agentfest)
IONICE=$(command -v ionice || echo "$H/ionice"); SETSID=$(command -v setsid || echo "$H/setsid")
secs=$1; cap=$2; shift 2
read l1 l5 l15 _ < /proc/loadavg
avail=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
if awk -v l="$l1" 'BEGIN{exit !(l > 12)}' || [ "$avail" -lt 3500 ]; then echo "heavy.sh: box busy (load $l1, avail ${avail} MB): not starting" >&2; exit 75; fi
echo "heavy.sh: load $l1/$l5/$l15, avail ${avail} MB, cap ${cap} MB, ${secs}s: $*" >&2
"$SETSID" timeout "$secs" nice -n 10 "$IONICE" -c2 -n7 "$@" &
pid=$!
pgid=$(ps -o pgid= $pid | tr -d ' ')
while kill -0 $pid 2>/dev/null; do
  rss=$(ps -o rss= -g "$pgid" 2>/dev/null | awk '{s+=$1} END{print int(s/1024)}')
  if [ "${rss:-0}" -gt "$cap" ]; then echo "heavy.sh: memory ${rss} MB > ${cap} MB: killing group $pgid" >&2; kill -TERM -- -"$pgid"; sleep 2; kill -KILL -- -"$pgid" 2>/dev/null; fi
  sleep 1
done
wait $pid
