#!/bin/sh
cd /c/Users/user/Desktop/work/minecraft-claude
until grep -q "== конец" farm/portal-scan/batch3.log; do sleep 15; done
sh farm/portal-scan/pool.sh 0 100
