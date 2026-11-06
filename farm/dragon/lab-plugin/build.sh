#!/bin/sh
# Сборка DragonLab.jar: javac и jar из JDK 21, API — из библиотек слота 1.
cd "$(dirname "$0")" || exit 1
JAVAC=javac
JAR=jar
if [ -n "$JAVA_HOME" ]; then
  JAVAC="$JAVA_HOME/bin/javac"
  JAR="$JAVA_HOME/bin/jar"
fi
L=../../server-1/libraries
CP=$(find -L "$L" -name '*.jar' | paste -sd ';' -)
if [ -z "$CP" ]; then
  echo "Paper libraries not found in $L" >&2
  exit 1
fi
rm -rf out && mkdir -p out
"$JAVAC" --release 21 -nowarn -cp "$CP" -d out src/nd/lab/DragonLab.java || exit 1
cp plugin.yml out/ || exit 1
(cd out && "$JAR" cf ../DragonLab.jar .) && echo "ok: $(pwd)/DragonLab.jar"
