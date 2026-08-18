# modules/gui/audio_mixin.py
from __future__ import annotations

try:
    from modules.audio.audio_output import AudioOutput
except ImportError:
    from ..audio.audio_output import AudioOutput  # type: ignore[import]


class AudioOutputMixin:
    """MainWindow に音声出力機能を追加する Mixin。"""

    def _init_audio_output(self) -> None:
        self.audio_output = AudioOutput()

    def start_audio(self, engine_callback=None) -> None:
        if hasattr(self, "audio_output"):
            self.audio_output.start(engine_callback)

    def stop_audio(self) -> None:
        if hasattr(self, "audio_output"):
            self.audio_output.stop()

    def get_audio_latency(self) -> float:
        if hasattr(self, "audio_output"):
            latency = self.audio_output.get_latency()
            # sounddevice の latency は (input, output) の tuple を返す場合がある
            if isinstance(latency, tuple):
                return float(latency[1])  # 出力遅延のみを返す
            return float(latency)
        return 0.0
