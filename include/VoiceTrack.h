// VoiceTrack.h
//
// フェーズ4「マルチトラック／ミキサー」の土台。
//
// 【スコープの明記】
// UST自体は1ファイル=1パートの仕様（MidiChannelやTrack概念が無い）なので、
// UST再生は常にトラック0を使う。マルチトラックが活きるのは主に
// 「複数のMIDIチャンネルにそれぞれ違う音源を割り当てて同時に鳴らす」
// ライブ演奏用途（例: ハモりパートを別チャンネルの別音源で）。
// 本格的な複数トラック対応のUST風プロジェクト形式（.vsp等）を読み書きする
// 機能は対象外（それは別途プロジェクトファイル形式の設計が必要になる）。
//
// トラック数は固定4（kMaxTracks）。動的追加/削除は今回対象外。

#pragma once

#include "StreamingVoice.h"
#include "OtoDatabase.h"
#include <atomic>

struct VoiceTrack
{
    StreamingVoice voice;
    OtoDatabase    otoDb;

    std::atomic<float> gain  { 1.0f };  // 線形ゲイン
    std::atomic<float> pan   { 0.0f };  // -1.0(左) .. 0.0(中央) .. 1.0(右)
    std::atomic<bool>  muted { false };

    juce::String voiceDirPath; // UI表示用（読み込み済みフォルダのパス）

    bool startStreaming (VoseCoreLibrary& core, double sampleRate, int bufferMs)
    {
        return voice.start (core, sampleRate, bufferMs);
    }
};
