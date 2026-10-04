#!/bin/sh
# Сборка DragonLab.jar (лаборатория взрыва кровати): javac/jar из JBR Android Studio, API — из библиотек слота 1.
cd "$(dirname "$0")" || exit 1
JB="/c/Program Files/Android/Android Studio/jbr/bin"
L=../../server-1/libraries
CP=$(find $L -name '*.jar' | tr '\n' ';')
rm -rf out && mkdir -p out
"$JB/javac.exe" --release 21 -nowarn -cp "$CP" -d out src/nd/lab/DragonLab.java || exit 1
cp plugin.yml out/
(cd out && "$JB/jar.exe" cf ../DragonLab.jar .) && echo "ok: $(pwd)/DragonLab.jar"
