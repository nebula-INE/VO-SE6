// VoseLookAndFeel.h
//
// フェーズ3「テーマ切り替え（ダーク/ライト）」。
// themes/dark.qss / themes/light.qss（PySide6版、"Apple Refined Style"）の
// 配色をそのままJUCEの juce::LookAndFeel_V4 に移植したもの。
//
// 標準ウィジェット（ボタン/スライダー/テキストボックス等）は
// LookAndFeel_V4::ColourScheme で見た目が決まるため、qssの色をそのまま
// ColourScheme に対応付けている。PianoRollComponent / GraphEditorComponent /
// VoiceGalleryComponent のような自前描画コンポーネントは標準ColourSchemeの
// 範囲外なので、追加で VoseColourIds.h のカスタムIDに色を割り当てている。
//
// 使い方（PluginEditor.h側）:
//   VoseLookAndFeel lookAndFeel { true /* ダークモードで開始 */ };
//   setLookAndFeel (&lookAndFeel); // コンストラクタで
//   setLookAndFeel (nullptr);      // デストラクタで必ず解除する（JUCEの規約）
//
//   themeToggleButton.onClick = [this]
//   {
//       lookAndFeel.toggleTheme(); // 互換用メソッド
//       repaint();
//   };

#pragma once

#include <juce_gui_basics/juce_gui_basics.h>
#include "VoseColourIds.h"

class VoseLookAndFeel : public juce::LookAndFeel_V4
{
public:
    // --- 【ブリッジ用】他コンポーネントが直接アクセスするテーマ定義 ---
    enum class Theme { Dark, Light };

    // --- 【ブリッジ用】直接アクセスされるカラーメンバ変数 ---
    juce::Colour colourBackground;
    juce::Colour colourSurface;
    juce::Colour colourAccent;
    juce::Colour colourText;
    juce::Colour colourTextDim;

    explicit VoseLookAndFeel (bool startInDarkMode = true)
    {
        setDarkMode (startInDarkMode);
    }

    void setDarkMode (bool dark)
    {
        darkMode = dark;
        setColourScheme (dark ? buildDarkColourScheme() : buildLightColourScheme());
        registerCustomColours (dark);

        // --- 【ブリッジ用】直接参照メンバ変数への同期処理 ---
        colourBackground = findColour (VoseColourIds::canvasBackground);
        colourSurface    = findColour (VoseColourIds::galleryCardBackground);
        colourAccent     = findColour (VoseColourIds::accentPrimary);
        colourText       = dark ? juce::Colour (0xfff5f5f7) : juce::Colour (0xff1c1c1e);
        colourTextDim    = colourText.withAlpha (0.6f);
    }

    bool isDarkMode() const { return darkMode; }

    // --- 【ブリッジ用】他コンポーネントが呼び出すメソッド群 ---
    Theme getTheme() const { return darkMode ? Theme::Dark : Theme::Light; }
    void toggleTheme() { setDarkMode (!darkMode); }

private:
    bool darkMode = true;

    // LookAndFeel_V4::ColourScheme のコンストラクタ引数順序:
    // windowBackground, widgetBackground, menuBackground, outline,
    // defaultText, defaultFill, highlightedText, highlightedFill, menuText
    static ColourScheme buildDarkColourScheme()
    {
        return {
            juce::Colour (0xff1c1c1e), // windowBackground   (QMainWindow bg)
            juce::Colour (0xff2c2c2e), // widgetBackground    (QPushButton/QLineEdit bg)
            juce::Colour (0xff2c2c2e), // menuBackground      (QComboBox popup bg)
            juce::Colour (0xff48484a), // outline             (ボーダー色)
            juce::Colour (0xfff5f5f7), // defaultText         (QLabel文字色)
            juce::Colour (0xff3a3a3c), // defaultFill         (hover背景)
            juce::Colour (0xffffffff), // highlightedText
            juce::Colour (0xff0a84ff), // highlightedFill     (accentButton色)
            juce::Colour (0xfff5f5f7)  // menuText
        };
    }

    static ColourScheme buildLightColourScheme()
    {
        return {
            juce::Colour (0xfff5f5f7), // windowBackground
            juce::Colour (0xffe5e5ea), // widgetBackground
            juce::Colour (0xffffffff), // menuBackground
            juce::Colour (0xffd1d1d6), // outline
            juce::Colour (0xff1c1c1e), // defaultText
            juce::Colour (0xffd1d1d6), // defaultFill
            juce::Colour (0xffffffff), // highlightedText
            juce::Colour (0xff007aff), // highlightedFill
            juce::Colour (0xff1c1c1e)  // menuText
        };
    }

    void registerCustomColours (bool dark)
    {
        const auto bg        = dark ? juce::Colour (0xff1c1c1e) : juce::Colour (0xfff5f5f7);
        const auto header     = dark ? juce::Colour (0xff17171c) : juce::Colour (0xffe5e5ea);
        const auto rowAlt     = dark ? juce::Colour (0xff26262e) : juce::Colour (0xffe5e5ea);
        const auto border     = dark ? juce::Colour (0xff48484a) : juce::Colour (0xffd1d1d6);
        const auto text       = dark ? juce::Colour (0xfff5f5f7) : juce::Colour (0xff1c1c1e);
        const auto accent     = dark ? juce::Colour (0xff0a84ff) : juce::Colour (0xff007aff);
        const auto keyWhite   = dark ? juce::Colour (0xffe8e8ec) : juce::Colour (0xffffffff);
        const auto keyBlack   = dark ? juce::Colour (0xff0c0c10) : juce::Colour (0xff1c1c1e);
        const auto cardBg     = dark ? juce::Colour (0xff2c2c2e) : juce::Colour (0xffffffff);

        setColour (VoseColourIds::canvasBackground, bg);
        setColour (VoseColourIds::canvasHeaderBackground, header);
        setColour (VoseColourIds::canvasRowAlt, rowAlt);
        setColour (VoseColourIds::canvasGrid, border.withAlpha (0.5f));
        setColour (VoseColourIds::canvasGridBeat, border.withAlpha (0.8f));
        setColour (VoseColourIds::canvasGridMeasure, text.withAlpha (0.4f));
        setColour (VoseColourIds::accentPrimary, accent);
        setColour (VoseColourIds::noteSelected, juce::Colour (0xffffb74d)); // オレンジ系はどちらのテーマでも視認性が高いので共通
        setColour (VoseColourIds::keyboardWhite, keyWhite);
        setColour (VoseColourIds::keyboardBlack, keyBlack);
        setColour (VoseColourIds::galleryCardBackground, cardBg);
        setColour (VoseColourIds::galleryCardBorder, border);
    }
};
