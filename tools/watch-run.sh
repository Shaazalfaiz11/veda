#!/usr/bin/env bash
# Polls one assessment until it reaches a terminal state, logging each change.
ID="$1"
LOG=".logs/run-$ID.log"
last=""
for i in $(seq 1 240); do
  body=$(curl -s "http://localhost:3000/api/assessments/$ID/status")
  line=$(echo "$body" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const o=JSON.parse(s);console.log([o.status,o.stage||'-',JSON.stringify(o.progress||{})].join(' | '))}catch(e){console.log('parse-error')}})")
  if [ "$line" != "$last" ]; then
    echo "$(date -u +%H:%M:%S) $line" | tee -a "$LOG"
    last="$line"
  fi
  case "$line" in
    COMPLETED*|FAILED*) echo "TERMINAL: $line" | tee -a "$LOG"; exit 0 ;;
  esac
  sleep 10
done
echo "TIMEOUT after 40 minutes" | tee -a "$LOG"
