// StreamingVoice.h
//
// vose_core の本物のリアルタイムAPI (streaming_render_*) を使う。
// RenderEngine.h (オフラインバウンス方式) と違い、ここでは自前の
// バックグラウンドスレッドを持たない。合成スレッドは vose_core 内部の
// StreamingSynthesizer::synth_loop が既にやってくれていて、
// pull() は SPSC ロックフリー RingBuffer から読むだけなので
// processBlock から直接呼んでも安全。
//
// 用途の切り分け:
//   - リアルタイム再生・プレビュー → StreamingVoice (このファイル)
//   - 完成音声のバウンス/書き出し   → RenderEngine.h (execute_render)
//   どちらも同じ synthesize_note_impl を通るので音質は同一。

#pragma once

#include "VoseBridge.h"
#include <juce_audio_basics/juce_audio_basics.h>

class StreamingVoice
{
public:
    // core は呼び出し側（プロセッサ）が所有するライブラリ参照を渡す。
    // サンプルレートが決まる prepareToPlay 以降でのみ start() を呼ぶこと。
    bool start (VoseCoreLibrary& coreLib, double sampleRate, int bufferMs = 500)
    {
        core = &coreLib;
        stop(); // 既存があれば破棄してから作り直す

        if (! core->supportsStreaming())
            return false;

        VoseStreamConfig cfg {};
        cfg.sample_rate        = (int) sampleRate;
        cfg.buffer_ms          = bufferMs;
        cfg.mode_flag          = 0; // 0=Free(16bit)。Pro版切替はフェーズ2でパラメータ化
        cfg.initial_tempo_bpm  = 120.0f;
        cfg.on_chunk_ready     = nullptr; // フェーズ1ではUI向け解析コールバックは未使用
        cfg.callback_user_data = nullptr;

        handle = core->streaming_render_create (&cfg);
        return handle != nullptr;
    }

    void stop()
    {
        if (handle != nullptr && core != nullptr && core->streaming_render_destroy != nullptr)
            core->streaming_render_destroy (handle);
        handle = nullptr;
    }

    ~StreamingVoice() { stop(); }

    // MIDIノートオン等から呼ぶ。カーブは note_id ごとに寿命管理する必要はなく、
    // push_note の呼び出し中にコアが内部コピー(QueuedNote)するので、
    // この関数を抜けた後にベクタが破棄されても問題ない。
    // portamentoOffsetsCents は空でよい（その場合ポルタメント無し=0セント）。
    void pushNote (int64_t noteId, const juce::String& wavPath,
                   const std::vector<double>& pitchCurve,
                   const std::vector<double>& genderCurve,
                   const std::vector<double>& tensionCurve,
                   const std::vector<double>& breathCurve,
                   const std::vector<double>& portamentoOffsetsCents = {})
    {
        if (handle == nullptr || core == nullptr || core->streaming_render_push_note == nullptr)
            return;

        VoseStreamNote n {};
        n.note_id            = noteId;
        n.wav_path           = wavPath.toRawUTF8();
        n.pitch_length       = (int) pitchCurve.size();
        n.pitch_curve        = pitchCurve.data();
        n.gender_curve       = genderCurve.data();
        n.tension_curve      = tensionCurve.data();
        n.breath_curve       = breathCurve.data();

        // ネイティブ対応（VoseStreamNoteに実在するフィールド。簡略化されていない
        // 汎用処理なので忠実度の劣化なし。ビブラートと違いここは安心して使える）。
        n.portamento_offsets = portamentoOffsetsCents.empty() ? nullptr : portamentoOffsetsCents.data();
        n.portamento_length  = (int) portamentoOffsetsCents.size();

        core->streaming_render_push_note (handle, &n);
    }

    // processBlock から直接呼ぶ。ロックフリーなので待たない。
    // 戻り値は実際に読み出せたサンプル数（バッファ枯渇時は要求数より少ない）。
    int pull (float* dst, int numSamples)
    {
        if (handle == nullptr || core == nullptr || core->streaming_render_pull == nullptr)
            return 0;
        return core->streaming_render_pull (handle, dst, numSamples);
    }

    double getBufferedMs() const
    {
        if (handle == nullptr || core == nullptr || core->streaming_render_buffered_ms == nullptr)
            return 0.0;
        return core->streaming_render_buffered_ms (handle);
    }

    void setTempo (float bpm)
    {
        if (handle != nullptr && core != nullptr && core->streaming_render_set_tempo != nullptr)
            core->streaming_render_set_tempo (handle, bpm);
    }

    bool isActive() const { return handle != nullptr; }

private:
    VoseCoreLibrary* core = nullptr;
    VoseStreamHandle handle = nullptr;
};
