# modules/gui/settings_dialog.py
from PySide6.QtWidgets import (QDialog, QVBoxLayout, QTableWidget, QTableWidgetItem, 
                               QPushButton, QHeaderView, QKeySequenceEdit, QHBoxLayout, QLabel)
from PySide6.QtCore import QSettings, Qt
from PySide6.QtGui import QKeySequence
from PySide6.QtGui import QAction # 💡 明示的なインポートの追加
from typing import List, Tuple

class ShortcutSettingsDialog(QDialog):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("キーボードショートカットの割り当て")
        self.setMinimumSize(520, 380)
        
        layout = QVBoxLayout(self)
        
        # DAWに馴染むスタイリッシュな説明文
        desc = QLabel("変更したい機能の右側の欄をクリックし、割り当てたいキーボードの組み合わせを入力してください。")
        desc.setWordWrap(True)
        desc.setStyleSheet("color: #8e8e93; font-size: 11px; margin-bottom: 4px;")
        layout.addWidget(desc)

        # テーブルの構築
        self.table = QTableWidget()
        self.table.setColumnCount(2)
        self.table.setHorizontalHeaderLabels(["コマンド / アクション", "ショートカットキー"])
        self.table.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        self.table.horizontalHeader().setSectionResizeMode(1, QHeaderView.ResizeMode.Interactive)
        self.table.setColumnWidth(1, 200)
        self.table.setAlternatingRowColors(True)
        
        # 高級感のあるダークテーマ用QSS
        self.table.setStyleSheet("""
            QTableWidget {
                background-color: #1e1e1e;
                color: #f2f2f7;
                gridline-color: #2c2c2e;
                border: 1px solid #2c2c2e;
                border-radius: 6px;
            }
            QTableWidget::item { padding: 4px; }
            QHeaderView::section {
                background-color: #2c2c2e;
                color: #aeaeae;
                padding: 6px;
                border: none;
                font-weight: bold;
            }
        """)
        
        # 🌟 修正ポイント1: 変数名を self.shortcut_actions にリネーム
        # QWidget.actions() メソッドとの名前バッティングを完全に防ぎます。
        # 親ウィジェットから返ってくる型情報が不確実な場合を想定し、List[Tuple[str, QAction]] として明示。
        raw_actions = parent.get_all_actions() if parent and hasattr(parent, "get_all_actions") else []
        self.shortcut_actions: List[Tuple[str, QAction]] = raw_actions
        
        self.populate_table()
        layout.addWidget(self.table)
        
        # ボタングループ
        btn_layout = QHBoxLayout()
        
        btn_clear = QPushButton("選択アサインを解除")
        btn_clear.setStyleSheet("background-color: #3a3a3c; color: #ff453a; padding: 5px 10px;")
        btn_clear.clicked.connect(self.clear_selected_shortcut)
        
        btn_save = QPushButton("設定を適用")
        btn_save.setStyleSheet("background-color: #007aff; color: white; font-weight: bold; padding: 5px 15px;")
        btn_save.clicked.connect(self.save_shortcuts)
        
        btn_cancel = QPushButton("キャンセル")
        btn_cancel.clicked.connect(self.reject)
        
        btn_layout.addWidget(btn_clear)
        btn_layout.addStretch()
        btn_layout.addWidget(btn_cancel)
        btn_layout.addWidget(btn_save)
        layout.addLayout(btn_layout)

    def populate_table(self):
        # 🌟 修正ポイント2: 変更した変数名を参照
        self.table.setRowCount(len(self.shortcut_actions))
        for i, (name, action) in enumerate(self.shortcut_actions):
            # アクション表示名（ユーザー編集不可）
            item_name = QTableWidgetItem(name)
            item_name.setFlags(item_name.flags() & ~Qt.ItemFlag.ItemIsEditable)
            self.table.setItem(i, 0, item_name)
            
            # Qt純正の高性能キーシーケンスエディタを埋め込み
            keyseq_widget = QKeySequenceEdit()
            keyseq_widget.setKeySequence(action.shortcut())
            self.table.setCellWidget(i, 1, keyseq_widget)

    def clear_selected_shortcut(self):
        """選択されている行のショートカットを初期化（なし）にする"""
        curr_row = self.table.currentRow()
        if curr_row >= 0:
            widget = self.table.cellWidget(curr_row, 1)
            if isinstance(widget, QKeySequenceEdit):
                widget.setKeySequence(QKeySequence())

    def save_shortcuts(self):
        # テーマ保存と連動させるため "vocal" でレジストリを統一
        settings = QSettings("VO-SE", "vocal")
        for i in range(self.table.rowCount()):
            # 🌟 修正ポイント3: 変更した変数名を参照
            action = self.shortcut_actions[i][1]
            widget = self.table.cellWidget(i, 1)
            if isinstance(widget, QKeySequenceEdit):
                new_keyseq = widget.keySequence()
                action.setShortcut(new_keyseq)
                # 確実に一意化された objectName をキーにして保存
                settings.setValue(f"shortcuts/{action.objectName()}", new_keyseq.toString())
        self.accept()
