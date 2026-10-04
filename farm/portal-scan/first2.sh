#!/bin/sh
cd /c/Users/user/Desktop/work/minecraft-claude
node farm/portal-scan/scan.js gen 29 384 &
node farm/portal-scan/scan.js gen 30 384 &
wait
node --max-old-space-size=6144 farm/portal-scan/scan.js scan 29 384
node --max-old-space-size=6144 farm/portal-scan/scan.js scan 30 384
sh farm/portal-scan/loop.sh 4 384
