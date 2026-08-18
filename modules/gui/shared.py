# ==========================================================================
# modules/gui/shared.py
# ==========================================================================

import os
import sys
import importlib
from typing import Any, cast


def get_resource_path(relative_path: str) -> str:
    """
    内蔵DLLやアセットなどのリソースパスを取得する。

    PyInstaller等でEXE化された後（sys.frozen=True）は一時展開フォルダ
    (sys._MEIPASS) を基準にし、開発中（.py実行）はこのファイルの場所を
    基準にする。
    """
    if getattr(sys, 'frozen', False):
        base_path = getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(__file__)))
    else:
        # 🌟 修正ポイント: モジュールが別階層 (modules/gui/) に移動したことへの追従
        # 元々 main_window.py (例: プロジェクト直下や別階層) にあった関数が
        # modules/gui/shared.py に引っ越したため、開発環境における base_path が
        # 意図せず「modules/gui/」を基準にしてアセットを探しに行ってしまいます。
        # 必要に応じて、プロジェクトルートを指すように `..` で遡るか、絶対パスの基準を調整します。
        current_dir = os.path.dirname(os.path.abspath(__file__))
        base_path = os.path.abspath(os.path.join(current_dir, "..", "..")) # プロジェクトルートに調整
        
    return os.path.normpath(os.path.join(base_path, relative_path))


# --------------------------------------------------------------------------
# DynamicsAIEngine: 標準のDynamics AIエンジン。
# modules.utils.dynamics_ai からの動的import。失敗時はパススルーの
# フォールバッククラスを使う（元の main_window.py と同じロジック）。
# --------------------------------------------------------------------------
try:
    DynamicsAIEngine = importlib.import_module("modules.utils.dynamics_ai").DynamicsAIEngine  # type: ignore[attr-defined]
except Exception:
    class _DynamicsAIEngineFallback:
        def generate_emotional_pitch(self, f0: Any) -> Any:  # 💡 型アノテーションを追加して静的解析を強化
            return f0
    DynamicsAIEngine = cast(Any, _DynamicsAIEngineFallback)
