# ==========================================================================
# modules/gui/mixins/_mixin_base.py
#
# 各 Mixin (ProjectIOMixin など) が MainWindow から多重継承されることを
# 前提に使っている属性/メソッドを、Pyright だけに教えるためのファイル。
#
# 実行時には一切影響しない（TYPE_CHECKING内でしか使われない）。
# MainWindow 側で新しい属性を追加した場合は、ここにも追記すること。
# ==========================================================================
from typing import TYPE_CHECKING, Any, Dict, List

if TYPE_CHECKING:
    from PySide6.QtWidgets import QMainWindow, QLineEdit

    class _MainWindowAttrs(QMainWindow):
        """
        MainWindow (modules/gui/main_window.py) が実際に持っている属性・
        メソッドのうち、Mixin 側から参照されているものの一覧。
        QMainWindow を継承させることで self.statusBar() や、
        QFileDialog/QMessageBox への self 渡しも型エラーにならない。
        """

        # === UIウィジェット ===
        timeline_widget: Any
        graph_editor_widget: Any
        tempo_input: "QLineEdit"

        # === トラック・データ管理 ===
        current_track_idx: int
        tracks: List[Any]
        confirmed_partners: Dict[int, str]
        voice_manager: Any

        # === メソッド ===
        def update_timeline_with_notes(self, notes_data: list) -> None: ...
        def on_voice_changed(self, display_name: str, internal_id: str) -> None: ...
        def stop_and_clear_playback(self) -> None: ...
        def update_tempo_from_input(self) -> None: ...
        def update_scrollbar_range(self) -> None: ...
        def update_scrollbar_v_range(self) -> None: ...
        def _get_yomi_from_lyrics(self, lyrics: str) -> str: ...
        def log_startup(self, message: str) -> None: ...
        def handle_playback(self) -> None: ...
        def _sample_range(self, events: Any, note: Any, res: int) -> list: ...

    _MixinBase = _MainWindowAttrs
else:
    # 実行時はただの object。MRO にも余計な影響を与えない。
    _MixinBase = object
