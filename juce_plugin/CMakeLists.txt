# ==============================================================================
# juce_plugin/CMakeLists.txt
#
# VO-SE vocal JUCE Plugin ビルド設定（完全自動・最適化版）
# ==============================================================================

cmake_minimum_required(VERSION 3.22)

project(VoseVocalPlugin VERSION 0.1.0 LANGUAGES CXX)
project(VoseVocalPlugin VERSION 0.1.0 LANGUAGES C CXX)

# ========================
# C++ 標準設定
# ========================
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# ========================
# JUCE フレームワークの取得
# ========================
include(FetchContent)
FetchContent_Declare(
    JUCE
    GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
    GIT_TAG 8.0.5
    GIT_SHALLOW TRUE
)
FetchContent_MakeAvailable(JUCE)

# ========================
# 外部ライブラリ検出 (macOS 用 iconv)
# ========================
if(APPLE)
    find_package(Iconv REQUIRED)   # Iconv::Iconv ターゲットが生成される
endif()

# ========================
# プラグインフォーマット定義
# ========================
set(VOSE_PLUGIN_FORMATS VST3 Standalone)
if(APPLE)
    list(APPEND VOSE_PLUGIN_FORMATS AU)
endif()

# ========================
# JUCE プラグイン定義
# ========================
juce_add_plugin(VoseVocal
    COMPANY_NAME              "VO-SE Project"
    PLUGIN_BUNDLE_ID          "com.vose-project.vosevocal"   # ← BUNDLE_ID → PLUGIN_BUNDLE_ID
    PLUGIN_MANUFACTURER_CODE  Vose
    PLUGIN_CODE               Vse1
    FORMATS                   ${VOSE_PLUGIN_FORMATS}
    PRODUCT_NAME              "VO-SE vocal"
    NEEDS_MIDI_INPUT          TRUE
    IS_SYNTH                  TRUE
    COPY_PLUGIN_AFTER_BUILD   FALSE
)

# ========================
# ソースファイル定義（VOSE_OPTIONAL_SOURCES のループは削除）
# ========================
file(GLOB VOSE_SOURCES
    "${CMAKE_CURRENT_SOURCE_DIR}/../src/*.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/../include/*.h"
)

# ★ プラグインでは不要なファイルを除外 ★
list(REMOVE_ITEM VOSE_SOURCES
    "${CMAKE_CURRENT_SOURCE_DIR}/../src/vose_streaming_final.cpp"
    # 必要に応じて他のファイルも追加
)

if(NOT VOSE_SOURCES)
    message(FATAL_ERROR "[VO-SE] No source files found in src/ !")
endif()

target_sources(VoseVocal PRIVATE ${VOSE_SOURCES})


# ========================
# インクルードディレクトリ
# ========================
target_include_directories(VoseVocal
    PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/include          # juce_plugin/include（必要なら）
        ${CMAKE_CURRENT_SOURCE_DIR}/../src           # リポジトリルートの src
        ${CMAKE_CURRENT_SOURCE_DIR}/../include       # リポジトリルートの include
)

# ========================
# コンパイル定義（全プラットフォーム共通）
# ========================
target_compile_definitions(VoseVocal
    PUBLIC
        JUCE_WEB_BROWSER=0
        JUCE_USE_CURL=0
        JUCE_VST3_CAN_REPLACE_VST2=0
)

# ========================
# Linux 固有設定
# ========================
if(UNIX AND NOT APPLE)
    target_compile_definitions(VoseVocal PUBLIC JUCE_ALSA=1)
endif()

# ========================
# macOS 固有設定
# ========================
if(APPLE)
    # メインターゲット（VoseVocal）の設定
    if(TARGET VoseVocal)
        set_target_properties(VoseVocal PROPERTIES
            MACOSX_DEPLOYMENT_TARGET "11.0"
        )
    endif()

    # 共有コードターゲット（VoseVocal_SharedCode）の設定
    if(TARGET VoseVocal_SharedCode)
        set_target_properties(VoseVocal_SharedCode PROPERTIES
            MACOSX_DEPLOYMENT_TARGET "11.0"
        )
    endif()
endif()
# ========================
# Windows 固有設定
# ========================
if(WIN32)
    target_compile_options(VoseVocal PRIVATE /wd4996)
endif()

# ========================
# JUCE ライブラリのリンク（共通）
# ========================
target_link_libraries(VoseVocal
    PUBLIC
        juce::juce_recommended_config_flags
        juce::juce_recommended_lto_flags
        juce::juce_recommended_warning_flags
    PRIVATE
        juce::juce_audio_utils
        juce::juce_audio_processors
        juce::juce_gui_basics
        juce::juce_dsp
)

# ========================
# macOS 用 iconv リンク（全ターゲットに伝播）
# ========================
if(APPLE)
    # メインターゲットにリンク
    target_link_libraries(VoseVocal PRIVATE Iconv::Iconv)

    # サブターゲット（共有コード・各フォーマット）にも明示的にリンク
    foreach(subtarget IN ITEMS VoseVocal_SharedCode VoseVocal_VST3 VoseVocal_AU VoseVocal_Standalone)
        if(TARGET ${subtarget})
            target_link_libraries(${subtarget} PRIVATE Iconv::Iconv)
        endif()
    endforeach()
endif()

# ========================
# ビルド構成のデバッグ出力
# ========================
message(STATUS "=======================================================")
message(STATUS "[VO-SE] Plugin Build Configuration:")
message(STATUS "  - CMAKE_BUILD_TYPE:    ${CMAKE_BUILD_TYPE}")
message(STATUS "  - PLUGIN_FORMATS:      ${VOSE_PLUGIN_FORMATS}")
message(STATUS "  - SOURCE_DIR:          ${CMAKE_CURRENT_SOURCE_DIR}")
message(STATUS "=======================================================")
