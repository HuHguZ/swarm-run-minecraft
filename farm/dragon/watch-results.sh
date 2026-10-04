#!/bin/sh
# Печатает строку на каждый новый итог боя в farm/logs/<префикс>*.jsonl: sh watch-results.sh "v2- c2-"
L=/c/Users/user/Desktop/work/minecraft-claude/farm/logs
PRE=${1:-v2-}
files () { for p in $PRE; do ls $L/$p*.jsonl 2>/dev/null; done; }
count () { n=0; for f in $(files); do c=$(wc -l < $f); n=$((n + c)); done; echo $n; }
prev=$(count)
while true; do
  n=$(count)
  if [ "$n" -gt "$prev" ]; then
    for f in $(ls -t $(files) | head -$((n - prev))); do
      tail -1 $f | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const r=JSON.parse(s);const c=(r.cause||{}).lastHurt||{};console.log(require('path').basename('$f'), new Date(Date.parse(r.at)+3*3600e3).toISOString().slice(11,19), r.killed&&!r.died?'WIN':r.died?'DEATH '+c.type+'/'+c.doing:'NONE', r.secs+'s', 'kill@'+r.killSecs, 'dragon='+r.dragonHp)}catch(e){console.log('parse error', '$f')}})"
    done
    prev=$n
  fi
  sleep 10
done
