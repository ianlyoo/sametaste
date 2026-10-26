#!/bin/bash
# Runs landing.mjs on the Mac (ssh mac, real GPU) and brings its screenshots and boxes back.
#
#   eval/motion/landing.sh OUTDIR URL NAME [landing.mjs args...]     e.g. TUNNEL="3017" eval/motion/landing.sh out http://127.0.0.1:3017/ home --live https://…
#
# TUNNEL="3017" reverse-forwards local ports to the Mac, as in run.sh. Prints landing.mjs's verdict lines (also OUTDIR/landing.txt).
set -u
OUT=$1; URL=$2; NAME=$3; shift 3
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$OUT"
FWD=""; for p in ${TUNNEL:-}; do FWD="$FWD -R $p:127.0.0.1:$p"; done
tar czf - -C "$HERE" landing.mjs | ssh -o BatchMode=yes mac "mkdir -p /tmp/motion && tar xzf - -C /tmp/motion" || { echo "ssh/tar to mac failed"; exit 1; }
LABEL=landing-$(basename "$OUT")-$$
ssh -o BatchMode=yes $FWD mac "set -e; mkdir -p /tmp/motion/out/$LABEL; cd /tmp/motion; /opt/homebrew/bin/node landing.mjs --out /tmp/motion/out/$LABEL --url '$URL' --name $NAME $* > /tmp/motion/out/$LABEL/$NAME.txt 2>&1 || true; tar czf - -C /tmp/motion/out $LABEL; rm -rf /tmp/motion/out/$LABEL" | tar xzf - -C "$OUT" --strip-components=1
cat "$OUT/$NAME.txt"
