// GraphEditorComponent.h
//
// フェーズ3「ユーザーインターフェースの本格化」— グラフエディタ
// （Pitch/Gender/Tension/Breath カーブ編集）。
// modules/gui/graph_editor_widget.py（PySide6版）の編集ロジックをJUCEネイティブで
// 再実装したもの。移植した挙動:
//   - 4種類のモード（Pitch/Gender/Tension/Breath）を切り替えて編集
//   - ダブルクリックでポイント追加（同時刻の既存ポイントは置き換え）
//   - ドラッグでポイント移動、右クリックで削除
//   - ペンモード（連続描画）: ドラッグ中、一定ピクセル間隔ごとに自動追加
//   - 現在編集中でないパラメータのカーブも薄い色（ゴースト）で重ねて表示
//   - ホバー中のポイントを拡大表示
//
// Python版との差分（意図的な簡略化）:
//   - Undo/Redo（edit_committed_signal相当）は実装していない。ピアノロールと
//     同様、このフェーズでは単純な直接編集のみとしている。
//   - スナップ機能は元のPython版にも無いので実装していない（自由な時刻/値）。
//
// 設計方針は PianoRollComponent と同じ: このコンポーネントは
// VoseAudioProcessor を一切知らず、AutomationCurves のみを扱う。
// モード切り替え・ペンモードのトグルボタンはこのコンポーネントの外
// （PluginEditor側のツールバー）に置き、setMode()/setPenMode() 経由で操作する
// （スクロール内容とツールバーが一体化しないようにするため。PianoRollComponent
// の鍵盤サイドバーで残した簡略化と対称的に、ここでは逆にツールバーを外出しに
// することで同じ問題を避けている）。

#pragma once

#include <juce_gui_basics/juce_gui_basics.h>
#include "AutomationCurves.h"
#include "VoseColourIds.h"
#include <functional>

class GraphEditorComponent : public juce::Component,
                              private juce::Timer
{
public:
    GraphEditorComponent();
    ~GraphEditorComponent() override = default;

    // --- モード / ペン ---
    void setMode (AutomationParam newMode);
    AutomationParam getMode() const { return mode; }

    void setPenMode (bool enabled);
    bool isPenMode() const { return penMode; }

    // --- データ ---
    void setCurves (AutomationCurves newCurves);
    const AutomationCurves& getCurves() const { return curves; }

    void setTempo (double bpm);
    void setHorizontalZoom (double newPixelsPerSecond);

    // 高さはPluginEditor側のレイアウトに委ねる（幅だけ内容量に応じて自動拡張する）。
    void setViewHeight (int newHeight);

    void setPlayheadSecondsProvider (std::function<double()> provider);

    // 編集のたびに呼ばれる。
    std::function<void (const AutomationCurves&)> onCurvesChanged;

    // --- juce::Component ---
    void paint (juce::Graphics&) override;
    void resized() override;
    void mouseDown (const juce::MouseEvent&) override;
    void mouseDrag (const juce::MouseEvent&) override;
    void mouseUp (const juce::MouseEvent&) override;
    void mouseMove (const juce::MouseEvent&) override;

private:
    static constexpr float kPointRadius = 4.0f;
    static constexpr float kPointRadiusHover = 6.0f;
    static constexpr float kHitTestPx = 8.0f;
    static constexpr float kPenIntervalPx = 6.0f;
    static constexpr double kSameTimeEpsilonSec = 0.001;

    double xToTimeSec (float x) const;
    float  timeSecToX (double t) const;
    double yToValue (float y, AutomationParam forMode) const;
    float  valueToY (double value, AutomationParam forMode) const;

    juce::Colour colourFor (AutomationParam p) const;
    juce::String labelFor (AutomationParam p) const;

    void recalculateContentWidth();
    void notifyChanged();

    // 現在のモードのカーブから pos に近いポイントのインデックスを探す（無ければ-1）。
    int hitTestPoint (juce::Point<float> pos) const;

    void addOrReplacePoint (double timeSec, double value);
    void addOrUpdatePenPoint (juce::Point<float> pos);

    void timerCallback() override;

    AutomationCurves curves;
    AutomationParam mode = AutomationParam::pitch;
    bool penMode = false;

    double tempoBpm = 120.0;
    double pixelsPerSecond = 90.0; // PianoRollComponentと同じデフォルト値（時間軸を視覚的に揃えるため）

    // ドラッグ状態
    int draggingPointIndex = -1;
    juce::Point<float> lastPenPos;
    bool penDragging = false;
    int hoverPointIndex = -1;

    std::function<double()> playheadProvider;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (GraphEditorComponent)
};
