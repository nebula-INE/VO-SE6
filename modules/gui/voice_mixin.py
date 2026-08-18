# modules/gui/voice_mixin.py
from __future__ import annotations
from typing import Dict

try:
    from modules.audio.voice_manager import VoiceManager
except ImportError:
    from ..audio.voice_manager import VoiceManager  # type: ignore[import]


class VoiceManagerMixin:
    """MainWindow に音声管理機能を追加する Mixin。"""

    def _init_voice_manager(self) -> None:
        self.voice_manager = VoiceManager()

    def get_available_voices(self) -> Dict[str, str]:
        """利用可能な音源の辞書 { 名前: パス } を返す。"""
        if hasattr(self, "voice_manager"):
            return self.voice_manager.scan_voices()
        return {}

    def get_voice_path(self, voice_name: str) -> str | None:
        """指定音源の絶対パスを返す。"""
        if hasattr(self, "voice_manager"):
            return self.voice_manager.get_voice_path(voice_name)
        return None

    def is_internal_voice(self, voice_name: str) -> bool:
        """内蔵（公式埋め込み）音源かどうかを判定する。"""
        if hasattr(self, "voice_manager"):
            return self.voice_manager.is_internal(voice_name)
        return False
