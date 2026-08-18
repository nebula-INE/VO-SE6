// VoiceInfo.h
//
// modules/audio/voice_manager.py の VoiceManager.voices（{名前: パス}の辞書、
// "__INTERNAL__" という特殊パスで内蔵音源を表す）に相当する構造体。

#pragma once

#include <juce_core/juce_core.h>

struct VoiceInfo
{
    juce::String name;        // 表示名（フォルダ名、または内蔵音源なら固定名）
    juce::File   directory;   // oto.iniが置かれているフォルダ。内蔵音源の場合は無効なFileのまま
    bool         isEmbedded = false; // true の場合 directory は無視し、コア側に焼き込まれた内蔵音源を使う
};
