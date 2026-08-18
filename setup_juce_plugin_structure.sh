#!/bin/bash
# setup_juce_plugin_structure.sh
#
# VO-SE vocal JUCE Plugin ディレクトリ構造を自動作成するスクリプト
#
# 使用方法:
#   bash setup_juce_plugin_structure.sh [--move-files] [--help]
#
# オプション:
#   --move-files   : 既存のプラグイン関連ファイルを自動的に juce_plugin/ に移動
#   --help         : ヘルプを表示

set -euo pipefail

# ========================
# 設定
# ========================
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
JUCE_PLUGIN_DIR="${REPO_ROOT}/juce_plugin"
MOVE_FILES=false
VERBOSE=true

# ========================
# ヘルパー関数
# ========================
log_info() {
    if [ "$VERBOSE" = true ]; then
        echo "ℹ️  $*"
    fi
}

log_success() {
    if [ "$VERBOSE" = true ]; then
        echo "✅ $*"
    fi
}

log_warning() {
    if [ "$VERBOSE" = true ]; then
        echo "⚠️  $*"
    fi
}

log_error() {
    echo "❌ Error: $*" >&2
}

show_help() {
    cat << 'EOF'
VO-SE vocal JUCE Plugin ディレクトリセットアップスクリプト

使用方法:
  bash setup_juce_plugin_structure.sh [options]

オプション:
  --move-files    既存のプラグイン関連ファイル（include/*.h, src/*.cpp等）を
                  自動的に juce_plugin/ ディレクトリに移動します
  --no-verbose    詳細ログ出力を無効化
  --help          このヘルプを表示

実行後に行うべきこと:
  1. PluginEditor.h のファイル名確認（小文字e ではなく大文字E）
  2. include/ の全 .h ファイルが配置されたか確認
  3. src/ の全 .cpp ファイルが配置されたか確認
  4. CMakeLists.txt を juce_plugin/ に配置
  5. ローカルでビルドテスト（オプション）:
     cmake -B juce_plugin/build -S juce_plugin -DCMAKE_BUILD_TYPE=Release
     cmake --build juce_plugin/build --config Release --parallel

例:
  # デフォルト（ディレクトリ作成のみ）
  bash setup_juce_plugin_structure.sh

  # 既存ファイルを自動移動
  bash setup_juce_plugin_structure.sh --move-files
EOF
}

# ========================
# コマンドライン引数処理
# ========================
while [[ $# -gt 0 ]]; do
    case "$1" in
        --move-files)
            MOVE_FILES=true
            shift
            ;;
        --no-verbose)
            VERBOSE=false
            shift
            ;;
        --help)
            show_help
            exit 0
            ;;
        *)
            log_error "Unknown option: $1"
            show_help
            exit 1
            ;;
    esac
done

# ========================
# ディレクトリ作成
# ========================
log_info "Creating juce_plugin directory structure..."

mkdir -p "${JUCE_PLUGIN_DIR}/include"
mkdir -p "${JUCE_PLUGIN_DIR}/src"

log_success "Created ${JUCE_PLUGIN_DIR}/"
log_success "Created ${JUCE_PLUGIN_DIR}/include/"
log_success "Created ${JUCE_PLUGIN_DIR}/src/"

# ========================
# ファイル自動移動（オプション）
# ========================
if [ "$MOVE_FILES" = true ]; then
    log_info "Moving plugin-related files to juce_plugin/..."

    # include ディレクトリから .h ファイルを探して移動
    PLUGIN_HEADERS=(
        "PluginProcessor.h"
        "PluginEditor.h"
        "Plugineditor.h"  # 小文字バージョンも試す
        "PianoRollComponent.h"
        "GraphEditorComponent.h"
        "OtoDatabase.h"
        "UstParser.h"
        "VowelClassifier.h"
        "StreamingVoice.h"
        "PitchCurveBuilder.h"
        "VoseBridge.h"
    )

    for header in "${PLUGIN_HEADERS[@]}"; do
        # トップレベルの include/ から探す
        if [ -f "${REPO_ROOT}/include/${header}" ]; then
            log_info "Moving ${header}..."
            mv "${REPO_ROOT}/include/${header}" "${JUCE_PLUGIN_DIR}/include/"
        fi
    done

    # src ディレクトリから .cpp ファイルを探して移動
    PLUGIN_SOURCES=(
        "PluginProcessor.cpp"
        "PluginEditor.cpp"
        "PianoRollComponent.cpp"
        "GraphEditorComponent.cpp"
        "OtoDatabase.cpp"
        "UstParser.cpp"
        "VowelClassifier.cpp"
        "StreamingVoice.cpp"
        "PitchCurveBuilder.cpp"
        "VoseBridge.cpp"
    )

    for source in "${PLUGIN_SOURCES[@]}"; do
        # トップレベルの src/ から探す
        if [ -f "${REPO_ROOT}/src/${source}" ]; then
            log_info "Moving ${source}..."
            mv "${REPO_ROOT}/src/${source}" "${JUCE_PLUGIN_DIR}/src/"
        fi
    done

    log_success "File movement completed"
fi

# ========================
# PluginEditor.h のファイル名チェック
# ========================
log_info "Checking PluginEditor.h filename..."

if [ -f "${JUCE_PLUGIN_DIR}/include/Plugineditor.h" ]; then
    log_warning "Found 'Plugineditor.h' (lowercase 'e')"
    log_warning "Linux builds will fail with this filename!"
    log_warning "Rename to 'PluginEditor.h' (uppercase 'E'):"
    log_warning "  mv ${JUCE_PLUGIN_DIR}/include/Plugineditor.h ${JUCE_PLUGIN_DIR}/include/PluginEditor.h"
elif [ -f "${JUCE_PLUGIN_DIR}/include/PluginEditor.h" ]; then
    log_success "PluginEditor.h (correct filename) is present"
else
    log_warning "PluginEditor.h not found in ${JUCE_PLUGIN_DIR}/include/"
    log_warning "Please ensure all plugin header files are in place"
fi

# ========================
# .gitignore に追加
# ========================
if [ -f "${REPO_ROOT}/.gitignore" ]; then
    if ! grep -q "^juce_plugin/build/$" "${REPO_ROOT}/.gitignore"; then
        log_info "Adding 'juce_plugin/build/' to .gitignore..."
        echo "juce_plugin/build/" >> "${REPO_ROOT}/.gitignore"
        log_success "Added to .gitignore"
    else
        log_info "juce_plugin/build/ already in .gitignore"
    fi
else
    log_warning ".gitignore not found at ${REPO_ROOT}/.gitignore"
fi

# ========================
# 最終確認
# ========================
echo ""
echo "================================"
echo "✅ Setup Complete!"
echo "================================"
echo ""
echo "ディレクトリ構造:"
tree "${JUCE_PLUGIN_DIR}" 2>/dev/null || find "${JUCE_PLUGIN_DIR}" -type f -o -type d | sort
echo ""
echo "次のステップ:"
echo "  1. CMakeLists.txt を juce_plugin/ にコピー:"
echo "     cp juce_plugin_CMakeLists.txt juce_plugin/CMakeLists.txt"
echo ""
echo "  2. PluginEditor.h のファイル名を確認（大文字E）"
echo ""
echo "  3. 不足しているファイルを確認・追加"
echo ""
echo "  4. ローカルでビルド（オプション）:"
echo "     cmake -B juce_plugin/build -S juce_plugin -DCMAKE_BUILD_TYPE=Release"
echo "     cmake --build juce_plugin/build --config Release --parallel"
echo ""
echo "  5. GitHub にコミット・プッシュ:"
echo "     git add juce_plugin/"
echo "     git commit -m 'feat: add JUCE plugin build structure'"
echo "     git push origin main"
echo ""
