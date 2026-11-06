@echo off
rem Build seedtool.exe with MSVC 2022. cubiomes is cloned next to the project:
rem ..\..\..\cubiomes-viewer\cubiomes, branch nd-1.21.11 (PR #162 1.21.5+/1.21.11 biome tree, #145, cherry_grove 1.21.9+).
setlocal
where cl.exe >nul 2>&1
if not errorlevel 1 goto build
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" goto no_compiler
for /f "usebackq delims=" %%I in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VS_ROOT=%%I"
if not defined VS_ROOT goto no_compiler
call "%VS_ROOT%\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1 || exit /b 1

:build
set "CUB=%~dp0..\..\..\cubiomes-viewer\cubiomes"
if defined CUBIOMES_DIR set "CUB=%CUBIOMES_DIR%"
cd /d "%~dp0" || exit /b 1
if not exist obj mkdir obj
cl /nologo /O2 /W1 /utf-8 /I"%CUB%" seedtool.c "%CUB%\biomenoise.c" "%CUB%\biomes.c" "%CUB%\finders.c" "%CUB%\generator.c" "%CUB%\layers.c" "%CUB%\noise.c" "%CUB%\quadbase.c" "%CUB%\util.c" /Fe:seedtool.exe /Fo:obj\ >build.log 2>&1
set RC=%ERRORLEVEL%
findstr /i /c:" error " /c:"fatal" build.log
exit /b %RC%

:no_compiler
echo MSVC C++ tools not found. Open an x64 Developer Command Prompt. 1>&2
exit /b 1
