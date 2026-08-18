# layout_manager.py
from PySide6.QtCore import QSettings, QByteArray
from PySide6.QtWidgets import QMainWindow
from typing import cast


def save_layout(window: QMainWindow):
    """ウィンドウの位置・サイズ・状態を保存します。"""
    settings = QSettings("VO-SE", "Pro")
    settings.setValue("geometry", window.saveGeometry())
    settings.setValue("windowState", window.saveState())

def restore_layout(window: QMainWindow):
    """ウィンドウの位置・サイズ・状態を安全に復元します。"""
    settings = QSettings("VO-SE", "vocal")
    
    # 🌟 処方箋: type= 指定を一度外し、Any を経由して強制的に QByteArray へキャストします。
    # これにより、PySide6の型定義の不備や、Pyrightの解釈不具合を完璧に無効化します。
    geometry_raw = settings.value("geometry")
    state_raw = settings.value("windowState")
    
    geometry = cast(QByteArray, geometry_raw) if geometry_raw else None
    state = cast(QByteArray, state_raw) if state_raw else None
    
    # 完全に空（初回起動時など）でないか、より厳密にチェック
    # (QByteArray型であることが確定したため、isEmpty() へのアクセスも安全です)
    if geometry and hasattr(geometry, "isEmpty") and not geometry.isEmpty():
        window.restoreGeometry(geometry)
    if state and hasattr(state, "isEmpty") and not state.isEmpty():
        window.restoreState(state)
