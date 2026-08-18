# juce_plugin/CMakeLists.txt
#
# フェーズ3のJUCEプラグイン本体（include/PluginProcessor.h, include/PluginEditor.h,
# include/PianoRollComponent.h 等）をビルドするための、独立したCMakeプロジェクト。
# 既存のトップレベル CMakeLists.txt（vose_core共有ライブラリ用）とは別に、
# このディレクトリを起点にビルドする想定:
#
#   cmake -B juce_plugin/build -S juce_plugin -DCMAKE_BUILD_TYPE=Release
#   cmake --build juce_plugin/build --config Release --parallel
#
# 注意（重要・ビルド前に確認してください）:
#   1. include/PluginProcessor.cpp は `#include "PluginEditor.h"`（大文字E）を
#      前提にしていますが、今回のダンプではファイル名が `Plugineditor.h`
#      （小文字e）でした。macOS/Windowsは大文字小文字を区別しないファイル
#      システムが多いため気付きにくいですが、Linuxランナー(ubuntu-latest)は
#      大文字小文字を区別するため、このままだとLinuxビルドだけ失敗します。
#      `include/Plugineditor.h` を `include/PluginEditor.h` にリネームするか、
#      PluginProcessor.cpp側のincludeを実ファイル名に合わせて修正してください。
#      （このリポジトリに一緒に納品したPluginEditor.hはリネーム済みのものです）
#   2. vose_core（DSPコア）はここではリンクしていません。VoseAudioProcessorの
#      コンストラクタが実行時に coreLib.load(...) で動的ロードする設計のため、
#      ビルド時のリンクは不要という前提で書いています。もし静的/動的リンクが
#      別途必要であれば target_link_libraries に追加してください。
#   3. OtoDatabase.h / UstParser.h / VowelClassifier.h / StreamingVoice.h /
#      PitchCurveBuilder.h / VoseBridge.h に対応する .cpp 実装ファイルが
#      このダンプに含まれていなかったため、ヘッダオンリー実装だと仮定して
#      PLUGIN_SOURCES に含めていません。もし別途 .cpp が存在する場合は
#      下のリストに追加してください。

cmake_minimum_required(VERSION 3.22)

project(VoseVocalPlugin VERSION 0.1.0)

# [重要] トップレベルの vose_core CMakeLists.txt では C++20 を使用しており、
# 特に vose_streaming_final.cpp が C++20 機能に依存しています。
# ここでも同じ標準を使うことで、ビルド時の型チェック互換性を保証します。
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)



# --- JUCEをFetchContentで取得（サブモジュール管理にしたい場合はここを add_subdirectory に変更） ---
include(FetchContent)
FetchContent_Declare(
    JUCE
    GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
    GIT_TAG 7.0.12
    GIT_SHALLOW TRUE
)
FetchContent_MakeAvailable(JUCE)

set(VOSE_REPO_ROOT ${CMAKE_CURRENT_SOURCE_DIR})

# --- ビルドフォーマット: VST3 + Standalone を全OS共通、AUはmacOSのみ追加 ---
set(VOSE_PLUGIN_FORMATS VST3 Standalone)
if (APPLE)
    list(APPEND VOSE_PLUGIN_FORMATS AU)
endif()

juce_add_plugin(VoseVocal
    COMPANY_NAME              "VO-SE Project"
    PLUGIN_MANUFACTURER_CODE  Vose
    PLUGIN_CODE               Vse1
    FORMATS                   ${VOSE_PLUGIN_FORMATS}
    PRODUCT_NAME              "VO-SE vocal"
    NEEDS_MIDI_INPUT          TRUE
    IS_SYNTH                  TRUE
    COPY_PLUGIN_AFTER_BUILD   FALSE
)

target_sources(VoseVocal
    PRIVATE
        ${VOSE_REPO_ROOT}/src/PluginProcessor.cpp
        ${VOSE_REPO_ROOT}/src/PianoRollComponent.cpp
        ${VOSE_REPO_ROOT}/src/GraphEditorComponent.cpp
        # 注意: OtoDatabase.h / UstParser.h / VowelClassifier.h / StreamingVoice.h /
        # PitchCurveBuilder.h / VoseBridge.h に対応する .cpp 実装ファイルが
        # 別途存在する場合（今回のダンプには含まれていなかったため確認が必要）、
        # 以下にそれらを追加してください:
        # ${VOSE_REPO_ROOT}/src/OtoDatabase.cpp
        # ${VOSE_REPO_ROOT}/src/UstParser.cpp
        # ${VOSE_REPO_ROOT}/src/VowelClassifier.cpp
        # ${VOSE_REPO_ROOT}/src/StreamingVoice.cpp
        # ${VOSE_REPO_ROOT}/src/PitchCurveBuilder.cpp
)

target_include_directories(VoseVocal
    PRIVATE
        ${VOSE_REPO_ROOT}/include
)

target_compile_definitions(VoseVocal
    PUBLIC
        JUCE_WEB_BROWSER=0
        JUCE_USE_CURL=0
        JUCE_VST3_CAN_REPLACE_VST2=0
        JUCE_ALSA=1
)

target_link_libraries(VoseVocal
    PRIVATE
        juce::juce_audio_utils
        juce::juce_audio_processors
        juce::juce_gui_basics
        juce::juce_dsp
    PUBLIC
        juce::juce_recommended_config_flags
        juce::juce_recommended_lto_flags
        juce::juce_recommended_warning_flags
)
