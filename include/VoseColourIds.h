// VoseColourIds.h
//
// PianoRollComponent / GraphEditorComponent / VoiceGalleryComponent はJUCE標準
// ウィジェットではなく自前でpaint()するコンポーネントなので、LookAndFeel_V4の
// 標準ColourScheme（ボタンや背景色）だけではテーマを反映できない。
// そこでこれらのコンポーネント固有の色をここにColourIdとして定義し、
// VoseLookAndFeel::setDarkMode() でまとめて設定する。
//
// 値は既存JUCE組み込みColourId（多くは0x1000000番台）と衝突しないよう
// 0x20000000番台を割り当てている。

#pragma once

namespace VoseColourIds
{
    enum
    {
        canvasBackground        = 0x20000001, // ピアノロール/グラフエディタの背景
        canvasHeaderBackground  = 0x20000002, // ルーラー/鍵盤サイドバーの背景
        canvasRowAlt            = 0x20000003, // ピアノロールの黒鍵行の背景
        canvasGrid              = 0x20000004, // 通常のグリッド線（16分音符など）
        canvasGridBeat          = 0x20000005, // 拍線
        canvasGridMeasure       = 0x20000006, // 小節線
        accentPrimary           = 0x20000007, // 未選択ノート/主要アクセント色
        noteSelected            = 0x20000008, // 選択中ノートの色
        keyboardWhite           = 0x20000009, // ピアノロール鍵盤の白鍵
        keyboardBlack           = 0x2000000a, // ピアノロール鍵盤の黒鍵
        galleryCardBackground   = 0x2000000b, // 音源ブラウザのカード背景
        galleryCardBorder       = 0x2000000c, // 音源ブラウザのカード枠線（非選択時）
    };
}
