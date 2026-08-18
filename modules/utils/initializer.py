import os
import sys

def get_resource_path(relative_path: str) -> str:
    # hasattrでチェックすることで Pyright のエラーを回避
    base_path = getattr(sys, '_MEIPASS', os.path.abspath("."))
    return os.path.join(base_path, relative_path)

class AppInitializer:
    @staticmethod
    def check_environment():
        """必要なファイルが揃っているかチェックし、足りなければエラーを返す"""
        # 実行環境(exe化後か)に応じたベースパスの取得
        if getattr(sys, 'frozen', False):
            # reportAttributeAccessIssue を回避するため getattr で安全に取得
            # sys._MEIPASS は PyInstaller が実行時に注入する特殊パス
            base_path = getattr(sys, '_MEIPASS', os.path.abspath("."))
        else:
            base_path = os.path.dirname(os.path.abspath(__file__))
            # modules/utils/ からプロジェクトルート (../../) へ移動
            base_path = os.path.join(base_path, "../../")

        # チェック対象リスト
        # 各プラットフォームに合わせたバイナリ名を判定
        if sys.platform == "win32":
            dll_names = ("vose_core.dll",)
        elif sys.platform == "darwin":
            dll_names = ("libvose_core.dylib", "vose_core.dylib")
        else:
            dll_names = ("libvose_core.so", "vose_core.so")
        jtalk_bin = "open_jtalk.exe" if sys.platform == "win32" else "open_jtalk"

        required_files = [
            os.path.join(base_path, "models", "onset_detector.onnx"),
            os.path.join(base_path, "bin", "open_jtalk", jtalk_bin)
        ]

        missing = []
        if not any(os.path.exists(os.path.join(base_path, "bin", dll_name)) for dll_name in dll_names):
            missing.append(dll_names[0])

        for f in required_files:
            if not os.path.exists(f):
                missing.append(os.path.basename(f))

        if missing:
            return False, "以下の必須ファイルが見つかりません:\n" + "\n".join(missing)
        
        return True, "All clear"
