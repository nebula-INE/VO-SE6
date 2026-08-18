// VoiceGalleryComponent.h
//
// modules/gui/main_window.py の VoiceCardGallery 相当。
// 「音源フォルダの中にある各ボイスバンクのフォルダをカード状に並べて
// クリックで切り替える」というUXをJUCEネイティブで実装したもの
// （VoiceCardGalleryの実ソースは未確認のため、想定される一般的なUXから
// 新規実装している）。
//
// 【意図的な簡略化】カバー画像・詳細情報（音源説明文等）の表示は無し。
// フォルダ名と oto.ini の有無のみを表示するシンプルなリスト形式。

#pragma once

#include <juce_gui_basics/juce_gui_basics.h>
#include "PluginProcessor.h"
#include "VoseLookAndFeel.h"

class VoiceGalleryComponent : public juce::Component,
                               private juce::ListBoxModel
{
public:
    explicit VoiceGalleryComponent (VoseAudioProcessor& p) : processor (p)
    {
        addAndMakeVisible (rootLabel);
        rootLabel.setJustificationType (juce::Justification::centredLeft);

        for (int i = 0; i < VoseAudioProcessor::kMaxTracks; ++i)
            trackSelector.addItem ("トラック " + juce::String (i + 1), i + 1);
        trackSelector.setSelectedId (1, juce::dontSendNotification);
        addAndMakeVisible (trackSelector);

        chooseRootButton.onClick = [this]
        {
            chooser = std::make_unique<juce::FileChooser> (
                "音源フォルダの親ディレクトリを選択（複数ボイスバンクをまとめて表示）",
                juce::File::getSpecialLocation (juce::File::userHomeDirectory));

            chooser->launchAsync (juce::FileBrowserComponent::canSelectDirectories,
                                   [this] (const juce::FileChooser& fc)
            {
                auto dir = fc.getResult();
                if (dir.isDirectory())
                {
                    rootDir = dir;
                    rootLabel.setText (dir.getFullPathName(), juce::dontSendNotification);
                    rescan();
                }
            });
        };
        addAndMakeVisible (chooseRootButton);

        addAndMakeVisible (listBox);
        listBox.setModel (this);
        listBox.setRowHeight (36);
    }

    void setLookAndFeelRef (VoseLookAndFeel* lf)
    {
        vlf = lf;
        listBox.setColour (juce::ListBox::backgroundColourId,
                            vlf ? vlf->colourBackground : juce::Colours::black);
        repaint();
    }

    void resized() override
    {
        auto area = getLocalBounds().reduced (8);
        auto topRow = area.removeFromTop (28);
        chooseRootButton.setBounds (topRow.removeFromLeft (140));
        topRow.removeFromLeft (8);
        trackSelector.setBounds (topRow.removeFromLeft (110));
        topRow.removeFromLeft (8);
        rootLabel.setBounds (topRow);

        area.removeFromTop (8);
        listBox.setBounds (area);
    }

    std::function<void()> onVoiceLoaded; // ステータス表示更新等のフック

private:
    // --- juce::ListBoxModel ---
    int getNumRows() override { return (int) cards.size(); }

    void paintListBoxItem (int rowNumber, juce::Graphics& g, int width, int height, bool rowIsSelected) override
    {
        if (rowNumber < 0 || rowNumber >= (int) cards.size())
            return;

        const auto surface = vlf ? vlf->colourSurface : juce::Colours::darkgrey;
        const auto accent  = vlf ? vlf->colourAccent : juce::Colours::cyan;
        const auto text    = vlf ? vlf->colourText : juce::Colours::white;
        const auto textDim = vlf ? vlf->colourTextDim : juce::Colours::grey;

        g.fillAll (rowIsSelected ? accent.withAlpha (0.25f) : surface);

        const auto& c = cards[(size_t) rowNumber];
        auto bounds = juce::Rectangle<int> (0, 0, width, height).reduced (8, 4);

        g.setColour (text);
        g.setFont (juce::Font (14.0f, juce::Font::bold));
        g.drawFittedText (c.name, bounds.removeFromTop (height / 2), juce::Justification::centredLeft, 1);

        g.setColour (c.hasOto ? textDim : juce::Colours::orangered);
        g.setFont (juce::Font (11.0f));
        g.drawFittedText (c.hasOto ? "oto.ini 検出済み" : "oto.ini が見つかりません",
                           bounds, juce::Justification::centredLeft, 1);
    }

    void listBoxItemClicked (int row, const juce::MouseEvent&) override
    {
        if (row < 0 || row >= (int) cards.size())
            return;

        const int trackIndex = trackSelector.getSelectedId() - 1;
        processor.loadVoiceDirectory (cards[(size_t) row].folder, trackIndex);
        if (onVoiceLoaded)
            onVoiceLoaded();
        repaint();
    }

    struct VoiceCard { juce::String name; juce::File folder; bool hasOto = false; };

    void rescan()
    {
        cards.clear();
        if (rootDir.isDirectory())
        {
            for (const auto& sub : rootDir.findChildFiles (juce::File::findDirectories, false))
            {
                VoiceCard c;
                c.name = sub.getFileName();
                c.folder = sub;
                c.hasOto = ! sub.findChildFiles (juce::File::findFiles, true, "oto.ini").isEmpty();
                cards.push_back (std::move (c));
            }
        }
        listBox.updateContent();
        repaint();
    }

    VoseAudioProcessor& processor;
    VoseLookAndFeel* vlf = nullptr;

    juce::File rootDir;
    juce::Label rootLabel { "root", "（音源フォルダの親ディレクトリ未選択）" };
    juce::TextButton chooseRootButton { "ルートを選択..." };
    juce::ComboBox trackSelector;
    std::unique_ptr<juce::FileChooser> chooser;

    juce::ListBox listBox { "voiceGallery" };
    std::vector<VoiceCard> cards;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (VoiceGalleryComponent)
};
