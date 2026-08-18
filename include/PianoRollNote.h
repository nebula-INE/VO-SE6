// PianoRollNote.h
//
// フェーズ3 UI: ピアノロール用の編集中ノート表現。
// modules/data/data_models.py の NoteEvent（start_time/duration/note_number/lyric...）
// に相当する最小サブセットを持つ。id は編集操作（移動・リサイズ・選択）を
// ソート順に依存せず追跡するために付与する（ScheduledSongNote には無い概念）。
//
// PianoRollComponent はこの構造体のリストだけを扱い、VoseAudioProcessor や
// ScheduledSongNote を一切知らない。プロセッサとの橋渡しは
// PianoRollBridge.h（toScheduledSongNotes / fromScheduledSongNotes）が担う。

#pragma once

#include <juce_core/juce_core.h>
#include <cstdint>

struct PianoRollNote
{
    int64_t      id = 0;
    double       startTimeSec = 0.0;
    double       durationSec  = 0.5;
    int          noteNum = 60;          // MIDIノート番号 (60=C4)
    juce::String lyric = "a";
    int          velocity = 100;        // 0-127（将来のベロシティ編集用、現状は表示のみ）
    bool         selected = false;

    double endTimeSec() const { return startTimeSec + durationSec; }
};
