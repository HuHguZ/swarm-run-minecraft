#!/bin/sh
cd /c/Users/user/Desktop/work/minecraft-claude
# дождаться конца прошлого цикла
while pgrep -f "portal-scan/first2.sh" >/dev/null 2>&1 || ps -W | grep -q "loop.sh"; do sleep 5; done
sh farm/portal-scan/loop.sh ${1:-12} 384
