// VoiceScanner.h
//
// modules/audio/voice_manager.py の VoiceManager.scan_voices() の移植。
// OS標準のUTAU/OpenUTAU音源フォルダと、実行ファイル脇の voice_banks フォルダを
// 再帰的に検索して oto.ini を持つフォルダを音源として列挙する。
// Python版と同じく、内蔵音源（コアDLLに焼き込み済み）を表す特別なエントリ
// （directory不使用、isEmbedded=true）を末尾に追加する。

#pragma once

#include <juce_core/juce_core.h>
#include "VoiceInfo.h"
#include <vector>

namespace VoiceScanner
{
    inline juce::File getInternalVoiceBanksDir()
    {
        auto exeDir = juce::File::getSpecialLocation (juce::File::currentApplicationFile).getParentDirectory();
        return exeDir.getChildFile ("voice_banks");
    }

    inline std::vector<juce::File> standardSearchRoots()
    {
        std::vector<juce::File> roots;

       #if JUCE_MAC
        roots.push_back (juce::File::getSpecialLocation (juce::File::userHomeDirectory)
                              .getChildFile ("Library/Application Support/OpenUTAU/Content/Voices"));
        roots.push_back (juce::File::getSpecialLocation (juce::File::userHomeDirectory)
                              .getChildFile ("Library/Application Support/Vocaloid/Voices")); // 互換用（Python版踏襲）
       #elif JUCE_WINDOWS
        roots.push_back (juce::File ("C:\\Program Files (x86)\\UTAU\\voice"));
        roots.push_back (juce::File::getSpecialLocation (juce::File::userApplicationDataDirectory)
                              .getChildFile ("OpenUTAU/Content/Voices")); // %APPDATA%相当
       #endif

        roots.push_back (getInternalVoiceBanksDir());
        return roots;
    }

    // 標準パス + 内蔵voice_banksフォルダを再帰的に検索し、oto.iniを持つフォルダを
    // すべて列挙する。最後に内蔵音源（Embedded）のエントリを1つ追加する。
    inline std::vector<VoiceInfo> scanInstalledVoices()
    {
        std::vector<VoiceInfo> result;
        juce::StringArray seenNames;

        for (auto& root : standardSearchRoots())
        {
            if (! root.isDirectory())
                continue;

            for (const auto& entry : juce::RangedDirectoryIterator (root, true, "oto.ini", juce::File::findFiles))
            {
                auto voiceDir = entry.getFile().getParentDirectory();
                auto name = voiceDir.getFileName();

                const int existingIdx = seenNames.indexOf (name);
                if (existingIdx >= 0)
                {
                    // Python版と同じく、同名が複数見つかった場合は後から見つかった方を優先する
                    result[(size_t) existingIdx].directory = voiceDir;
                }
                else
                {
                    VoiceInfo info;
                    info.name = name;
                    info.directory = voiceDir;
                    info.isEmbedded = false;
                    result.push_back (info);
                    seenNames.add (name);
                }
            }
        }

        VoiceInfo embedded;
        embedded.name = "VO-SE Official (Embedded)";
        embedded.isEmbedded = true;
        result.push_back (embedded);

        return result;
    }
}
