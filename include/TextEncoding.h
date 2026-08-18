// TextEncoding.h
//
// oto.ini / UST等、UTAU系ファイルの多くは Shift-JIS (CP932) で書かれている。
// JUCEにはCP932デコーダが標準で無いため、OS標準APIで変換する
// （追加の重い依存ライブラリを増やさない方針）:
//
//   Windows      : Win32 MultiByteToWideChar (codepage 932)
//   macOS/Linux  : POSIX iconv ("CP932" -> "UTF-8")
//
// Python版 (_read_safe / oto_parser.py の _read_safe) と同じ方針で、
// 1. まずUTF-8として厳密に妥当か検証
// 2. 妥当でなければ CP932 として変換を試みる
// 3. それも失敗したら Latin-1 相当の素通しで最低限読める形にする
// の順にフォールバックする。

#pragma once

#include <juce_core/juce_core.h>
#include <vector>
#include <cstring>

#if JUCE_WINDOWS
 #include <windows.h>
#else
 #include <iconv.h>
 #include <errno.h>
#endif

namespace vose_text
{
    // 厳密なUTF-8妥当性検証（不正なバイト列があれば false）。
    // juce::String::fromUTF8 は不正列を黙って置換/切り詰めるので、
    // 「本当にUTF-8として妥当か」を先に確認する必要がある。
    inline bool isValidUtf8 (const void* data, size_t size)
    {
        const auto* bytes = static_cast<const unsigned char*> (data);
        size_t i = 0;
        while (i < size)
        {
            const unsigned char c = bytes[i];
            int extra;
            if (c <= 0x7F)              extra = 0;
            else if ((c & 0xE0) == 0xC0) extra = 1;
            else if ((c & 0xF0) == 0xE0) extra = 2;
            else if ((c & 0xF8) == 0xF0) extra = 3;
            else return false;

            if (i + (size_t) extra >= size)
                return false;

            for (int j = 1; j <= extra; ++j)
                if ((bytes[i + (size_t) j] & 0xC0) != 0x80)
                    return false;

            i += (size_t) extra + 1;
        }
        return true;
    }

   #if JUCE_WINDOWS
    inline juce::String cp932ToUtf8 (const void* data, size_t size)
    {
        if (size == 0) return {};

        const int wideLen = MultiByteToWideChar (932, MB_ERR_INVALID_CHARS,
                                                   static_cast<LPCCH> (data), (int) size,
                                                   nullptr, 0);
        if (wideLen <= 0)
            return {}; // CP932としても不正 → 呼び出し側でLatin-1フォールバックへ

        std::vector<wchar_t> wide ((size_t) wideLen + 1);
        MultiByteToWideChar (932, 0, static_cast<LPCCH> (data), (int) size, wide.data(), wideLen);
        wide[(size_t) wideLen] = 0;

        return juce::String (wide.data());
    }
   #else
    inline juce::String cp932ToUtf8 (const void* data, size_t size)
    {
        if (size == 0) return {};

        iconv_t cd = iconv_open ("UTF-8", "CP932");
        if (cd == (iconv_t) -1)
            return {}; // iconvがCP932非対応にビルドされている等 → フォールバックへ

        std::vector<char> inBuf (size);
        std::memcpy (inBuf.data(), data, size);

        // 全角文字はUTF-8で最大3バイトになりうるので余裕を持って確保
        const size_t outCapacity = size * 4 + 16;
        std::vector<char> outBuf (outCapacity);

        char* inPtr  = inBuf.data();
        char* outPtr = outBuf.data();
        size_t inLeft  = size;
        size_t outLeft = outCapacity;

        const size_t result = iconv (cd, &inPtr, &inLeft, &outPtr, &outLeft);
        iconv_close (cd);

        if (result == (size_t) -1)
            return {}; // 変換失敗（不正なCP932バイト列など）→ フォールバックへ

        const size_t producedLen = outCapacity - outLeft;
        return juce::String::fromUTF8 (outBuf.data(), (int) producedLen);
    }
   #endif

    // Python版 _read_safe と同じ考え方: UTF-8 → CP932 → Latin-1素通し の順。
    inline juce::String decodeAutoEncoding (const void* data, size_t size)
    {
        if (size == 0)
            return {};

        if (isValidUtf8 (data, size))
            return juce::String::fromUTF8 (static_cast<const char*> (data), (int) size);

        auto viaCp932 = cp932ToUtf8 (data, size);
        if (viaCp932.isNotEmpty())
            return viaCp932;

        // 最終フォールバック: 1バイト=1文字のLatin-1として読む
        // (中身が化けても最低限クラッシュせず、oto.iniのASCII部分は保持される)
        juce::String result;
        result.preallocateBytes (size);
        const auto* bytes = static_cast<const unsigned char*> (data);
        for (size_t i = 0; i < size; ++i)
            result += juce::juce_wchar (bytes[i]);
        return result;
    }
}
