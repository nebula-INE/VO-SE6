// TrackMixerComponent.h
//
// フェーズ4「マルチトラック／ミキサー」のUI側。4トラック固定の簡易ミキサー。
// 音源フォルダの割り当て自体はVoiceGalleryComponent側のトラックセレクタで行う
// （役割分担: ここは音量/パン/ミュートのみ）。

#pragma once

#include <juce_gui_basics/juce_gui_basics.h>
#include "PluginProcessor.h"
#include "VoseLookAndFeel.h"

class TrackMixerComponent : public juce::Component, private juce::Timer
{
public:
    explicit TrackMixerComponent (VoseAudioProcessor& p) : processor (p)
    {
        for (int i = 0; i < VoseAudioProcessor::kMaxTracks; ++i)
        {
            auto& row = rows[(size_t) i];

            row.nameLabel.setText ("トラック " + juce::String (i + 1), juce::dontSendNotification);
            addAndMakeVisible (row.nameLabel);

            row.voiceLabel.setJustificationType (juce::Justification::centredLeft);
            addAndMakeVisible (row.voiceLabel);

            row.gainSlider.setRange (0.0, 2.0, 0.01);
            row.gainSlider.setValue (1.0, juce::dontSendNotification);
            row.gainSlider.setSliderStyle (juce::Slider::LinearHorizontal);
            row.gainSlider.setTextBoxStyle (juce::Slider::TextBoxRight, false, 50, 20);
            row.gainSlider.onValueChange = [this, i] { processor.setTrackGain (i, (float) rows[(size_t) i].gainSlider.getValue()); };
            addAndMakeVisible (row.gainSlider);

            row.panSlider.setRange (-1.0, 1.0, 0.01);
            row.panSlider.setValue (0.0, juce::dontSendNotification);
            row.panSlider.setSliderStyle (juce::Slider::LinearHorizontal);
            row.panSlider.setTextBoxStyle (juce::Slider::TextBoxRight, false, 50, 20);
            row.panSlider.onValueChange = [this, i] { processor.setTrackPan (i, (float) rows[(size_t) i].panSlider.getValue()); };
            addAndMakeVisible (row.panSlider);

            row.muteButton.setClickingTogglesState (true);
            row.muteButton.onClick = [this, i] { processor.setTrackMuted (i, rows[(size_t) i].muteButton.getToggleState()); };
            addAndMakeVisible (row.muteButton);
        }

        startTimerHz (2); // 音源フォルダ名の表示更新（他タブでの変更を拾う）
        refreshLabels();
    }

    void setLookAndFeelRef (VoseLookAndFeel* lf) { vlf = lf; repaint(); }

    void resized() override
    {
        auto area = getLocalBounds().reduced (12);
        const int rowH = area.getHeight() / VoseAudioProcessor::kMaxTracks;

        for (auto& row : rows)
        {
            auto r = area.removeFromTop (rowH).reduced (4);
            row.nameLabel.setBounds (r.removeFromLeft (80));
            row.muteButton.setBounds (r.removeFromLeft (60));
            row.voiceLabel.setBounds (r.removeFromLeft (140));
            row.gainSlider.setBounds (r.removeFromLeft (r.getWidth() / 2 - 4));
            r.removeFromLeft (8);
            row.panSlider.setBounds (r);
        }
    }

    void paint (juce::Graphics& g) override
    {
        g.fillAll (vlf ? vlf->colourBackground : juce::Colours::black);
    }

private:
    void timerCallback() override { refreshLabels(); }

    void refreshLabels()
    {
        for (int i = 0; i < VoseAudioProcessor::kMaxTracks; ++i)
            rows[(size_t) i].voiceLabel.setText (processor.getTrackVoiceDirName (i)
                                                  + " (" + juce::String (processor.getLoadedAliasCount (i)) + "音)",
                                                  juce::dontSendNotification);
    }

    struct TrackRow
    {
        juce::Label nameLabel, voiceLabel;
        juce::Slider gainSlider, panSlider;
        juce::TextButton muteButton { "Mute" };
    };

    VoseAudioProcessor& processor;
    VoseLookAndFeel* vlf = nullptr;
    std::array<TrackRow, VoseAudioProcessor::kMaxTracks> rows;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (TrackMixerComponent)
};
