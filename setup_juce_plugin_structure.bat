@echo off
REM setup_juce_plugin_structure.bat
REM
REM VO-SE vocal JUCE Plugin ディレクトリ構造を自動作成するスクリプト (Windows)
REM
REM 使用方法:
REM   setup_juce_plugin_structure.bat [--move-files] [--help]

setlocal enabledelayedexpansion

REM ========================
REM 設定
REM ========================
for /f "delims=" %%i in ('cd') do set "REPO_ROOT=%%i"
set "JUCE_PLUGIN_DIR=%REPO_ROOT%\juce_plugin"
set "MOVE_FILES=0"
set "VERBOSE=1"

REM ========================
REM コマンドライン引数処理
REM ========================
:parse_args
if "%~1"=="" goto end_parse
if "%~1"=="--move-files" (
    set "MOVE_FILES=1"
    shift
    goto parse_args
)
if "%~1"=="--no-verbose" (
    set "VERBOSE=0"
    shift
    goto parse_args
)
if "%~1"=="--help" (
    call :show_help
    endlocal
    exit /b 0
)
if "%~1"=="--help" goto show_help
shift
goto parse_args

:end_parse

REM ========================
REM ログ出力関数
REM ========================
setlocal enabledelayedexpansion

if %VERBOSE% equ 1 (
    echo [INFO] Creating juce_plugin directory structure...
)

REM ========================
REM ディレクトリ作成
REM ========================
if not exist "%JUCE_PLUGIN_DIR%" mkdir "%JUCE_PLUGIN_DIR%"
if not exist "%JUCE_PLUGIN_DIR%\include" mkdir "%JUCE_PLUGIN_DIR%\include"
if not exist "%JUCE_PLUGIN_DIR%\src" mkdir "%JUCE_PLUGIN_DIR%\src"

if %VERBOSE% equ 1 (
    echo [SUCCESS] Created %JUCE_PLUGIN_DIR%
    echo [SUCCESS] Created %JUCE_PLUGIN_DIR%\include
    echo [SUCCESS] Created %JUCE_PLUGIN_DIR%\src
)

REM ========================
REM ファイル自動移動（オプション）
REM ========================
if %MOVE_FILES% equ 1 (
    if %VERBOSE% equ 1 (
        echo [INFO] Moving plugin-related files to juce_plugin\...
    )

    REM .h ファイルを移動
    for %%f in (
        "include\PluginProcessor.h"
        "include\PluginEditor.h"
        "include\Plugineditor.h"
        "include\PianoRollComponent.h"
        "include\GraphEditorComponent.h"
        "include\OtoDatabase.h"
        "include\UstParser.h"
        "include\VowelClassifier.h"
        "include\StreamingVoice.h"
        "include\PitchCurveBuilder.h"
        "include\VoseBridge.h"
    ) do (
        if exist "%REPO_ROOT%\%%f" (
            if %VERBOSE% equ 1 (
                echo [INFO] Moving %%f...
            )
            move "%REPO_ROOT%\%%f" "%JUCE_PLUGIN_DIR%\%%~nf" >nul 2>&1
        )
    )

    REM .cpp ファイルを移動
    for %%f in (
        "src\PluginProcessor.cpp"
        "src\PluginEditor.cpp"
        "src\PianoRollComponent.cpp"
        "src\GraphEditorComponent.cpp"
        "src\OtoDatabase.cpp"
        "src\UstParser.cpp"
        "src\VowelClassifier.cpp"
        "src\StreamingVoice.cpp"
        "src\PitchCurveBuilder.cpp"
        "src\VoseBridge.cpp"
    ) do (
        if exist "%REPO_ROOT%\%%f" (
            if %VERBOSE% equ 1 (
                echo [INFO] Moving %%f...
            )
            move "%REPO_ROOT%\%%f" "%JUCE_PLUGIN_DIR%\%%~nf" >nul 2>&1
        )
    )

    if %VERBOSE% equ 1 (
        echo [SUCCESS] File movement completed
    )
)

REM ========================
REM PluginEditor.h のファイル名チェック
REM ========================
if %VERBOSE% equ 1 (
    echo [INFO] Checking PluginEditor.h filename...
)

if exist "%JUCE_PLUGIN_DIR%\include\Plugineditor.h" (
    echo [WARNING] Found 'Plugineditor.h' (lowercase 'e')
    echo [WARNING] Linux builds will fail with this filename!
    echo [WARNING] Rename to 'PluginEditor.h' (uppercase 'E')
) else if exist "%JUCE_PLUGIN_DIR%\include\PluginEditor.h" (
    if %VERBOSE% equ 1 (
        echo [SUCCESS] PluginEditor.h (correct filename) is present
    )
) else (
    echo [WARNING] PluginEditor.h not found in %JUCE_PLUGIN_DIR%\include\
    echo [WARNING] Please ensure all plugin header files are in place
)

REM ========================
REM .gitignore に追加
REM ========================
if exist "%REPO_ROOT%\.gitignore" (
    findstr /R "^juce_plugin/build/$" "%REPO_ROOT%\.gitignore" >nul 2>&1
    if errorlevel 1 (
        if %VERBOSE% equ 1 (
            echo [INFO] Adding 'juce_plugin/build/' to .gitignore...
        )
        echo juce_plugin/build/ >> "%REPO_ROOT%\.gitignore"
        if %VERBOSE% equ 1 (
            echo [SUCCESS] Added to .gitignore
        )
    ) else (
        if %VERBOSE% equ 1 (
            echo [INFO] juce_plugin/build/ already in .gitignore
        )
    )
) else (
    echo [WARNING] .gitignore not found at %REPO_ROOT%\.gitignore
)

REM ========================
REM 最終確認
REM ========================
echo.
echo ================================
echo [SUCCESS] Setup Complete!
echo ================================
echo.
echo Directory structure:
dir /S /B "%JUCE_PLUGIN_DIR%" 2>nul

echo.
echo Next steps:
echo   1. Copy CMakeLists.txt to juce_plugin/:
echo      copy juce_plugin_CMakeLists.txt juce_plugin\CMakeLists.txt
echo.
echo   2. Check PluginEditor.h filename (uppercase E)
echo.
echo   3. Verify all files are in place
echo.
echo   4. Local build test (optional):
echo      cmake -B juce_plugin\build -S juce_plugin -DCMAKE_BUILD_TYPE=Release
echo      cmake --build juce_plugin\build --config Release --parallel
echo.
echo   5. Commit and push to GitHub:
echo      git add juce_plugin\
echo      git commit -m "feat: add JUCE plugin build structure"
echo      git push origin main
echo.

endlocal
exit /b 0

REM ========================
REM ヘルプ表示
REM ========================
:show_help
echo VO-SE vocal JUCE Plugin Directory Setup Script
echo.
echo Usage:
echo   setup_juce_plugin_structure.bat [options]
echo.
echo Options:
echo   --move-files    Move existing plugin-related files (include/*.h, src/*.cpp)
echo                   automatically to juce_plugin\ directory
echo   --no-verbose    Disable verbose output
echo   --help          Display this help message
echo.
exit /b 0
