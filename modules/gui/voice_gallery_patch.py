# voice_gallery_patch.py
"""
main_window.py 内の VoiceCardWidget / VoiceCardGallery クラスを
この内容で「まるごと置き換える」ためのパッチ。

変更点:
- VoiceCardWidget: category("official"/"utau"/"recruiting") と検索用キーを保持し、
  matches(query, category) で自分がフィルター条件に合うか判定できるようにした。
- VoiceCardGallery: 上部に検索バー(QLineEdit)とカテゴリチップ(すべて/内蔵/UTAU/募集枠)を追加。
  再スキャンなしで高速に絞り込み表示できるよう、生成済みカードの並び順を
  self._entries に保持しておき、フィルター変更時はグリッドへの再配置のみ行う。
  該当0件のときは GalleryEmptyState ラベルを表示する。

適用方法:
  main_window.py 内の `class VoiceCardWidget(QFrame):` から
  `class AnalysisThread(QThread):` の直前までを、この内容で置き換えてください。
  （import は main_window.py の先頭で既に揃っているものだけで動きます。
    QLineEdit / QButtonGroup が未importの場合だけ追加してください）
"""
import os
from PySide6.QtWidgets import (
    QFrame, QWidget, QVBoxLayout, QHBoxLayout, QLabel, QGridLayout,
    QScrollArea, QLineEdit, QPushButton, QButtonGroup
)
from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QPixmap, QColor

from modules.gui.icons import icon


class VoiceCardWidget(QFrame):
    clicked = Signal()

    def __init__(self, display_name: str, icon_path: str, base_color: str,
                 is_recruiting: bool = False, category: str = "utau", parent=None):
        super().__init__(parent)

        # --- 1. 属性の代入 ---
        self.display_name = display_name
        self.is_recruiting = is_recruiting
        self.base_color = base_color
        # "official" | "utau" | "recruiting" — 検索/フィルター用の分類
        self.category = category
        self._search_key = display_name.lower()

        # --- 2. UIの基本設定 ---
        self.setFixedSize(140, 180)
        self.setCursor(Qt.CursorShape.PointingHandCursor)

        self.card_layout = QVBoxLayout(self)
        self.card_layout.setContentsMargins(10, 10, 10, 10)
        self.card_layout.setSpacing(8)

        # --- 3. アイコンエリアの構築 ---
        self.icon_label = QLabel()
        self.icon_label.setFixedSize(110, 110)
        self.icon_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.icon_label.setStyleSheet("background-color: rgba(0, 0, 0, 40); border-radius: 8px;")

        pixmap = QPixmap(icon_path)
        if pixmap.isNull():
            pixmap = QPixmap(110, 110)
            pixmap.fill(QColor(base_color).darker(150))

        self.icon_label.setPixmap(pixmap.scaled(
            110, 110,
            Qt.AspectRatioMode.KeepAspectRatioByExpanding,
            Qt.TransformationMode.SmoothTransformation
        ))

        if self.is_recruiting:
            overlay_layout = QVBoxLayout(self.icon_label)
            overlay_layout.setContentsMargins(0, 0, 0, 0)
            self.recruit_text = QLabel("UNDER\nRECRUITMENT")
            self.recruit_text.setAlignment(Qt.AlignmentFlag.AlignCenter)
            self.recruit_text.setStyleSheet("""
                color: #00FFCC; font-weight: bold; font-size: 10px;
                background-color: rgba(0, 20, 20, 180); border-radius: 4px;
            """)
            overlay_layout.addWidget(self.recruit_text)

        self.card_layout.addWidget(self.icon_label, 0, Qt.AlignmentFlag.AlignCenter)

        # --- 4. ラベルエリアの構築 ---
        self.name_label = QLabel(display_name)
        self.name_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.name_label.setWordWrap(True)
        self.name_label.setStyleSheet(f"""
            color: {'#888' if is_recruiting else 'white'};
            font-weight: {'normal' if is_recruiting else 'bold'};
            font-size: 11px;
        """)
        self.card_layout.addWidget(self.name_label)

        self.set_selected(False)

    def matches(self, query: str, category_filter: str) -> bool:
        """検索語(部分一致・大小無視)とカテゴリフィルターの両方に合致するか判定する"""
        if category_filter != "all" and self.category != category_filter:
            return False
        if query and query.lower() not in self._search_key:
            return False
        return True

    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton:
            self.clicked.emit()
            super().mousePressEvent(event)

    def set_selected(self, selected: bool):
        border_color = "#00FFCC" if selected else "#333333"
        bg_color = self.base_color if not selected else QColor(self.base_color).lighter(120).name()
        opacity = "1.0" if not self.is_recruiting else "0.7"

        self.setStyleSheet(f"""
            VoiceCardWidget {{
                background-color: {bg_color};
                border: 2px solid {border_color};
                border-radius: 12px;
                opacity: {opacity};
            }}
            VoiceCardWidget:hover {{
                border: 2px solid #00FFCC;
                background-color: {QColor(bg_color).lighter(110).name()};
            }}
        """)


# ==============================================================================
# ボイスカードギャラリー（検索・カテゴリ絞り込み対応版）
# ==============================================================================

class VoiceCardGallery(QWidget):
    """
    音源カードを並べて表示するメインコンテナ。
    上部の検索バー・カテゴリチップで絞り込みができる。
    """
    voice_selected = Signal(str, str)  # (表示名, 内部ID)
    clicked = Signal()

    CATEGORIES = [
        ("all", "すべて"),
        ("official", "内蔵"),
        ("utau", "UTAU音源"),
        ("recruiting", "募集枠"),
    ]

    def __init__(self, voice_manager):
        super().__init__()

        self.manager = voice_manager
        self.cards = {}            # internal_id -> VoiceCardWidget
        self.partner_data = {}
        self._entries = []         # [internal_id, ...] 生成順（フィルター再配置に使う）
        self._active_category = "all"
        self._empty_label = None

        self.main_layout = QVBoxLayout(self)
        self.main_layout.setContentsMargins(0, 0, 0, 0)
        self.main_layout.setSpacing(0)

        # --- 検索・フィルターバー ---
        self.main_layout.addWidget(self._build_filter_bar())

        # --- スクロールエリアとコンテナ ---
        self.scroll_area = QScrollArea()
        self.scroll_area.setWidgetResizable(True)
        self.scroll_area.setObjectName("GalleryScrollArea")
        self.scroll_area.setStyleSheet("QScrollArea#GalleryScrollArea { border: none; }")

        self.container = QWidget()
        self.grid = QGridLayout(self.container)
        self.grid.setSpacing(20)
        self.grid.setContentsMargins(20, 20, 20, 20)
        for i in range(4):
            self.grid.setColumnStretch(i, 1)

        self.scroll_area.setWidget(self.container)
        self.main_layout.addWidget(self.scroll_area)

    def _build_filter_bar(self) -> QWidget:
        bar = QWidget()
        bar.setObjectName("GalleryFilterBar")
        layout = QHBoxLayout(bar)
        layout.setContentsMargins(20, 14, 20, 10)
        layout.setSpacing(10)

        self.search_input = QLineEdit()
        self.search_input.setObjectName("SearchField")
        self.search_input.setPlaceholderText("音源を検索…")
        self.search_input.setClearButtonEnabled(False)  # 自前のクリアアクションを使う
        self.search_input.addAction(icon("search"), QLineEdit.ActionPosition.LeadingPosition)
        clear_action = self.search_input.addAction(icon("clear_x"), QLineEdit.ActionPosition.TrailingPosition)
        clear_action.triggered.connect(self.search_input.clear)
        self.search_input.textChanged.connect(lambda _: self._apply_filter())
        layout.addWidget(self.search_input, 1)

        self.category_group = QButtonGroup(self)
        self.category_group.setExclusive(True)
        for key, label in self.CATEGORIES:
            chip = QPushButton(label)
            chip.setObjectName("FilterChip")
            chip.setCheckable(True)
            chip.setChecked(key == "all")
            chip.clicked.connect(lambda checked, k=key: self._on_category_selected(k))
            self.category_group.addButton(chip)
            layout.addWidget(chip)

        return bar

    def _on_category_selected(self, key: str):
        self._active_category = key
        self._apply_filter()

    def set_partner_data(self, partners: dict):
        self.partner_data = partners

    def setup_gallery(self):
        """全音源を再スキャンしてカードを作り直す（音源追加/削除があった時に呼ぶ）"""
        if self.grid is not None:
            while self.grid.count() > 0:
                item = self.grid.takeAt(0)
                if item is not None:
                    widget = item.widget()
                    if widget is not None:
                        widget.setParent(None)
                        widget.deleteLater()

        self.cards.clear()
        self._entries.clear()

        all_voices = self.manager.scan_voices()

        for display_name, internal_id in all_voices.items():
            if internal_id.startswith("__INTERNAL__"):
                id_parts = internal_id.split(":", 1)
                char_dir = id_parts[1] if len(id_parts) > 1 else display_name
                base_path = getattr(self.manager, 'base_path', os.getcwd())
                icon_path = os.path.join(base_path, "assets", "official_voices", char_dir, "icon.png")
                card_color = "#3A3A4A"
                category = "official"
            else:
                icon_path = os.path.join(internal_id, "icon.png")
                card_color = "#2D2D2D"
                category = "utau"

            card = VoiceCardWidget(display_name, icon_path, card_color,
                                    is_recruiting=False, category=category)
            self._register_card(card, display_name, internal_id)

        loop_range = self.partner_data.keys() if self.partner_data else range(1, 11)
        for i in loop_range:
            display_name = f"PARTNER ID-{i:02d}"
            internal_id = f"__RECRUITING__:ID-{i:02d}"
            base_path = getattr(self.manager, 'base_path', os.getcwd())
            icon_path = os.path.join(base_path, "assets", "icons", "recruiting_placeholder.png")
            card_color = "#1A2222"
            card = VoiceCardWidget(display_name, icon_path, card_color,
                                    is_recruiting=True, category="recruiting")
            self._register_card(card, display_name, internal_id)

        self._apply_filter()

    def _register_card(self, card, display_name, internal_id):
        card.clicked.connect(
            lambda d=display_name, i=internal_id: self.on_card_clicked(d, i)
        )
        self.cards[internal_id] = card
        self._entries.append(internal_id)

    def _apply_filter(self):
        """検索語・カテゴリに合致するカードだけをグリッドに再配置する（再スキャンなし）"""
        query = self.search_input.text().strip() if hasattr(self, 'search_input') else ""

        # 1. グリッドから全ウィジェットを外す（削除はしない・使い回す）
        while self.grid.count() > 0:
            item = self.grid.takeAt(0)
            if item is not None:
                widget = item.widget()
                if widget is not None:
                    widget.setParent(None) 

        # 2. 合致するカードだけ拾う
        visible_ids = [
            internal_id for internal_id in self._entries
            if internal_id in self.cards and self.cards[internal_id].matches(query, self._active_category)
        ]

        if not visible_ids:
            empty = QLabel("該当する音源が見つかりません")
            empty.setObjectName("GalleryEmptyState")
            empty.setAlignment(Qt.AlignmentFlag.AlignCenter)
            self.grid.addWidget(empty, 0, 0, 1, 4)
            return

        max_columns = 4
        row, col = 0, 0
        for internal_id in visible_ids:
            card = self.cards[internal_id]
            card.setParent(self.container)
            card.setVisible(True)
            self.grid.addWidget(card, row, col)
            col += 1
            if col >= max_columns:
                col = 0
                row += 1

        self.grid.setRowStretch(row + 1, 1)

    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton:
            self.clicked.emit()
            super().mousePressEvent(event)

    def on_card_clicked(self, name, internal_id):
        for card_widget in self.cards.values():
            card_widget.set_selected(False)

        if internal_id in self.cards:
            self.cards[internal_id].set_selected(True)

        print(f"DEBUG: Gallery selection -> {name} ({internal_id})")
        self.voice_selected.emit(name, internal_id)
