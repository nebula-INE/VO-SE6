# icons.py
"""
テーマ(dark/light)に連動したアイコン取得ヘルパー。

assets/icons/dark/*.svg と assets/icons/light/*.svg に同名のSVGを置いておくと、
icon("play") のように呼ぶだけで現在のテーマに合った色のアイコンが返る。

使い方:
    from modules.gui.icons import icon
    self.play_btn.setIcon(icon("play"))
    self.play_btn.setIconSize(QSize(18, 18))

テーマ切り替え時は set_icon_theme() を呼んでおくと、以降の icon() 呼び出しが
新しいテーマの色のアイコンを返すようになる。既存ボタンのアイコンを更新したい
場合は、各ボタンで再度 setIcon(icon("..")) を呼び直す必要がある
(MainWindow._refresh_toolbar_icons() のようなメソッドでまとめて更新すると良い)。
"""
import os
from PySide6.QtGui import QIcon

_BASE_DIR = os.path.dirname(os.path.abspath(__file__))
_ICON_ROOT = os.path.join(_BASE_DIR, "..", "..", "assets", "icons")

_current_theme = "dark"


def set_icon_theme(theme_name: str) -> None:
    """'dark' または 'light' を指定してアイコンの配色セットを切り替える。"""
    global _current_theme
    _current_theme = "light" if theme_name == "light" else "dark"


def icon_path(name: str, theme: str | None = None) -> str:
    """アイコン名(拡張子なし)から現在のテーマに応じたSVGパスを返す。"""
    theme_name = theme or _current_theme
    filename = f"{name}.svg"
    path = os.path.join(_ICON_ROOT, theme_name, filename)
    if not os.path.exists(path):
        # フォールバック: darkセットを試す
        fallback = os.path.join(_ICON_ROOT, "dark", filename)
        if os.path.exists(fallback):
            return fallback
        print(f"[Icon Warning] Icon not found: {path}")
    return path


def icon(name: str, theme: str | None = None) -> QIcon:
    """QIcon を返す。見つからない場合は空のQIconを返す(呼び出し側での例外を防ぐ)。"""
    path = icon_path(name, theme)
    if os.path.exists(path):
        return QIcon(path)
    return QIcon()
