#!/bin/bash
# After a towerofhn deploy: is towerd up on the new version, voicing ahead, with every lane back, and the tailnet door serving?
S=http://towerofhan.apps.svc.cluster.local
echo "status: $(curl -s -m 8 $S:8787/status | jq -c '{items, voiced, tower, audience, cover, voicing}')"
echo "lanes:  $(curl -s -m 8 $S:8788/voice/status | jq -c '[.lanes[] | {node, threads, clips, rtf}]')"
echo "head:   $(curl -s -m 8 $S:8787/live/head.json | jq -c '{epoch, at_age_s: ((now*1000 - .at)/1000|floor), load, play, tower: (.tower|length)}')"
echo "livez:  $(curl -s -m 8 $S:8787/livez)"
B=$(python3 -c "import socket; print(socket.gethostbyname('traefik-tailnet.kube-system.svc.cluster.local'))" 2>/dev/null)
[ -n "$B" ] && echo "door:   $(curl -s -m 10 -o /dev/null -w '%{http_code} %{time_total}s' --resolve towerofhn.taptappers.club:443:$B https://towerofhn.taptappers.club/live/head.json)"
