# modules/gui/widgets.py
import os
from PySide6.QtWidgets import QFrame, QVBoxLayout, QLabel
from PySide6.QtCore import Signal, Qt
from PySide6.QtGui import QPixmap

class VoiceCardWidget(QFrame):
    clicked = Signal(str)

    def __init__(self, name, icon_path, color="#007AFF"):
        super().__init__()
        self.name = name
        self.color = color
        self._selected = False
        self.setFixedSize(120, 160)
        # PySide6の厳格な型指定に合わせる
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setObjectName("VoiceCard")
        
        layout = QVBoxLayout(self)
        self.icon_label = QLabel()
        pix = QPixmap(icon_path if os.path.exists(icon_path) else "assets/default_icon.png")
        
        # KeepAspectRatio などをフルパスで指定
        self.icon_label.setPixmap(pix.scaled(
            80, 80, 
            Qt.AspectRatioMode.KeepAspectRatio, 
            Qt.TransformationMode.SmoothTransformation
        ))
        self.icon_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        
        self.name_label = QLabel(self.name)
        self.name_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.name_label.setStyleSheet("font-weight: bold; color: white; font-size: 11px;")
        
        layout.addWidget(self.icon_label)
        layout.addWidget(self.name_label)
        self.update_style(False)

    def update_style(self, selected=False):
        border_color = self.color if selected else "rgba(255, 255, 255, 30)"
        bg_alpha = "60" if selected else "15"
        glow = f"border: 2px solid {border_color};" if selected else f"border: 1px solid {border_color};"
        self.setStyleSheet(f"#VoiceCard {{ background-color: rgba(255, 255, 255, {bg_alpha}); {glow} border-radius: 18px; }}")

    def mousePressEvent(self, event):
        # LeftButton もフルパスで指定
        if event is not None and event.button() == Qt.MouseButton.LeftButton:
            self.clicked.emit(self.name)
