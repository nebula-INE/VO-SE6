# modules/utils/log.py
# ============================================================
# VO-SE Pro 統一ログ設定モジュール
#
# ✅ 修正10: print() と logging が混在している問題の解消
#    旧コード: print(f"[Success] ...") / print(f"[Warning] ...") / logger.info(...)
#             が混在し、ログレベルによるフィルタリングや
#             ファイル出力が機能しない
#
#    修正方針:
#      - main.py の起動時にこのモジュールを呼んで logging を設定する
#      - 各モジュールは logging.getLogger(__name__) だけ使う
#      - print() は PyInstaller ビルド後に消えるので今後は書かない
# ============================================================

import logging
import logging.handlers
import os
import sys


def setup_logging(
    level: int = logging.INFO,
    log_to_file: bool = True,
    log_dir: str | None = None,
) -> None:
    """
    アプリ全体のログ設定を初期化する。
    main.py の冒頭（QApplication 生成前）で1回だけ呼ぶ。

    Args:
        level:       ルートロガーのログレベル（デフォルト INFO）
        log_to_file: True の場合ローテーションファイルにも出力
        log_dir:     ログファイルの保存先。None の場合 OS 標準ディレクトリ
    """
    fmt = logging.Formatter(
        fmt="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    root = logging.getLogger()
    root.setLevel(level)

    # ── コンソール出力 ────────────────────────────────────────
    console = logging.StreamHandler(sys.stderr)
    console.setLevel(level)
    console.setFormatter(fmt)
    root.addHandler(console)

    # ── ファイル出力（ローテーション: 1MB × 5世代） ────────────
    if log_to_file:
        if log_dir is None:
            # OS 標準のログディレクトリを使用
            if sys.platform == "win32":
                base = os.environ.get("LOCALAPPDATA", os.path.expanduser("~"))
            elif sys.platform == "darwin":
                base = os.path.expanduser("~/Library/Logs")
            else:
                base = os.environ.get("XDG_STATE_HOME", os.path.expanduser("~/.local/state"))
            log_dir = os.path.join(base, "VO-SE Pro")

        os.makedirs(log_dir, exist_ok=True)
        log_path = os.path.join(log_dir, "vose_pro.log")

        file_handler = logging.handlers.RotatingFileHandler(
            log_path,
            maxBytes=1024 * 1024,   # 1 MB
            backupCount=5,
            encoding="utf-8",
        )
        file_handler.setLevel(level)
        file_handler.setFormatter(fmt)
        root.addHandler(file_handler)

        logging.info("Log file: %s", log_path)


# ============================================================
# 各ファイルでの使い方:
#
#   import logging
#   logger = logging.getLogger(__name__)
#
#   # 旧コード:
#   print(f"[Success] C-Engine loaded: {path}")
#   print(f"[Warning] DLL not found")
#   print(f"[Error] Failed: {e}")
#
#   # 新コード:
#   logger.info("C-Engine loaded: %s", path)
#   logger.warning("DLL not found")
#   logger.error("Failed: %s", e, exc_info=True)
#
# ============================================================
