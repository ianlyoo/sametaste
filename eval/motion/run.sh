#!/bin/bash
# Records the scene's motion on the Mac (ssh mac, real GPU) for a list of size:sequence pairs, then analyses each run here.
#
#   eval/motion/run.sh OUTDIR URL "1920x1080:wheel 1920x1080:fast 390x844:touch-normal" [record.mjs args...]
#
# OUTDIR gets NAME.webm, NAME.probe.json, NAME.meta.json, NAME.summary.json and NAME-sheet-N.png per run (NAME = width-sequence),
# and index.txt with one verdict line per run. TUNNEL="3017 3018" reverse-forwards those local ports to the Mac, so a URL on
# 127.0.0.1 here is reachable there (a local next start, or prototype B served by python).
set -u
OUT=$1; URL=$2; RUNS=$3; shift 3
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$OUT"
FWD=""; for p in ${TUNNEL:-}; do FWD="$FWD -R $p:127.0.0.1:$p"; done
tar czf - -C "$HERE" record.mjs | ssh -o BatchMode=yes mac "mkdir -p /tmp/motion && tar xzf - -C /tmp/motion" || { echo "ssh/tar to mac failed"; exit 1; }
LABEL=$(basename "$OUT")-$$
REMOTE="set -e; rm -rf /tmp/motion/out/$LABEL; mkdir -p /tmp/motion/out/$LABEL; cd /tmp/motion"
# PACE="2:600": after every 2 runs, wait for the next 600 s wall-clock window (+15 s) before the next, for a page whose data comes
# from production's /api/agent (6 runs per 10 min fixed window per IP; / makes 3 per load, so 2 loads a window)
PACE=${PACE:-}; PACE_N=${PACE%%:*}; PACE_W=${PACE#*:}; k=0
for r in $RUNS; do
  size=${r%%:*}; seq=${r#*:}; name="${size%%x*}-$seq"
  if [ -n "${PACE:-}" ] && [ $k -gt 0 ] && [ $((k % PACE_N)) = 0 ]; then REMOTE="$REMOTE; sleep \$(( $PACE_W - \$(date +%s) % $PACE_W + 15 ))"; fi; k=$((k + 1))
  REMOTE="$REMOTE; /opt/homebrew/bin/node record.mjs --out /tmp/motion/out/$LABEL --url '$URL' --name $name --size $size --seq $seq $* 1>&2 || echo \"RECORD FAILED $name\" 1>&2"
done
REMOTE="$REMOTE; tar czf - -C /tmp/motion/out $LABEL; rm -rf /tmp/motion/out/$LABEL"
ssh -o BatchMode=yes $FWD mac "$REMOTE" 2> "$OUT/record.log" | tar xzf - -C "$OUT" --strip-components=1
grep -E "FAILED|FATAL|Error" "$OUT/record.log" | head -5
: > "$OUT/index.txt"
for f in "$OUT"/*.probe.json; do
  [ -e "$f" ] || continue; n=$(basename "$f" .probe.json)
  node "$HERE/analyze.mjs" "$f" --json "$OUT/$n.summary.json" | tee -a "$OUT/index.txt"
  [ -e "$OUT/$n.webm" ] && bash "$HERE/sheet.sh" "$OUT/$n.webm" "$OUT/$n-sheet" > /dev/null 2>&1
done
