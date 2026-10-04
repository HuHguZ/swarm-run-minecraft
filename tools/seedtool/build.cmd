@echo off
rem Build seedtool.exe with MSVC 2022. cubiomes is cloned next to the project:
rem ..\..\..\cubiomes-viewer\cubiomes, branch nd-1.21.11 (PR #162 1.21.5+/1.21.11 biome tree, #145, cherry_grove 1.21.9+).
setlocal
call "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1 || exit /b 1
set CUB=%~dp0..\..\..\cubiomes-viewer\cubiomes
cd /d %~dp0
if not exist obj mkdir obj
cl /nologo /O2 /W1 /utf-8 /I"%CUB%" seedtool.c "%CUB%\biomenoise.c" "%CUB%\biomes.c" "%CUB%\finders.c" "%CUB%\generator.c" "%CUB%\layers.c" "%CUB%\noise.c" "%CUB%\quadbase.c" "%CUB%\util.c" /Fe:seedtool.exe /Fo:obj\ >build.log 2>&1
set RC=%ERRORLEVEL%
findstr /i /c:" error " /c:"fatal" build.log
exit /b %RC%
