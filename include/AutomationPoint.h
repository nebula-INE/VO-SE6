// AutomationPoint.h
//
// modules/data/data_models.py の PitchEvent（time, value の2フィールドだけを持つ
// ブレークポイント）の1:1移植。GraphEditorComponent が扱う4種類のカーブ
// （Pitch/Gender/Tension/Breath）はすべてこの構造体のリストで表現する。
//
// 値の範囲（GraphEditorComponentの座標変換もこれに合わせている）:
//   - Pitch:              -8192 .. 8191  （modules/gui/graph_editor_widget.py の
//                          PITCH_MIN/PITCH_MAX を踏襲。MIDIピッチベンドに近い整数域）
//   - Gender/Tension/Breath: 0.0 .. 1.0  （APVTSの gender/tension/breath パラメータと同じレンジ）

#pragma once

struct AutomationPoint
{
    double time  = 0.0;   // 秒
    double value = 0.0;

    bool operator< (const AutomationPoint& other) const { return time < other.time; }
};
