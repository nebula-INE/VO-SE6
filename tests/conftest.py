# tests/conftest.py
import sys
import os
from pathlib import Path

# Linux/Headless環境でPySide6がクラッシュしないよう設定
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

# プロジェクトルートを sys.path に追加
repo_root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(repo_root))

try:
    from modules.utils.pyside_stub import setup_pyside_stub
    setup_pyside_stub()
except Exception:
    pass

