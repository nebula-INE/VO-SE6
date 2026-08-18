# intonation.py

import subprocess
import os
import sys
import re
import tempfile

class IntonationAnalyzer:
    def __init__(self):
        if getattr(sys, 'frozen', False):
            self.root = str(getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__))))
        else:
            # backend/ から見たプロジェクトルート (../)
            self.root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
            
        self.exe = os.path.join(self.root, "bin", "open_jtalk", "open_jtalk.exe")
        self.dic = os.path.join(self.root, "bin", "open_jtalk", "dic")

    def analyze(self, text):
        """テキストを解析してアクセント句情報(traceデータ)を返す"""
        # [FIX-TEMPFILE] カレントディレクトリに一時ファイルを作るのを廃止。
        # tempfile.NamedTemporaryFile を使い OS 標準の一時領域に安全に配置する。
        # これにより、PyInstaller バンドル後や読み取り専用ディレクトリからの実行でも動作する。
        abs_exe = os.path.abspath(self.exe)
        abs_dic = os.path.abspath(self.dic)

        # Windows では open_jtalk.exe が存在しないと NUL への書き出しも失敗するため
        # 実行ファイルの存在確認を事前に行う
        if not os.path.exists(abs_exe):
            print(f"[IntonationAnalyzer] open_jtalk not found: {abs_exe}")
            return ""

        try:
            with (
                tempfile.NamedTemporaryFile(
                    mode='w', suffix='.txt', delete=False, encoding='utf-8'
                ) as f_in,
                tempfile.NamedTemporaryFile(
                    mode='r', suffix='.txt', delete=False, encoding='utf-8'
                ) as f_trace
            ):
                temp_input = f_in.name
                temp_trace = f_trace.name

            # 入力テキストを書き込み
            with open(temp_input, 'w', encoding='utf-8') as f:
                f.write(text)

            # Windows では出力先に NUL を指定（音声出力を捨てる）、それ以外は /dev/null
            null_out = "NUL" if sys.platform == "win32" else "/dev/null"
            cmd = [abs_exe, "-x", abs_dic, "-ot", temp_trace, "-ow", null_out, temp_input]
            
            # [FIX-SHELL-TRUE] shell=True はセキュリティリスクかつ挙動が OS 依存。
            # cmd をリスト渡しにして shell=False（デフォルト）で実行する。
            subprocess.run(cmd, check=True, capture_output=True)

            if os.path.exists(temp_trace):
                with open(temp_trace, "r", encoding="utf-8") as f:
                    return f.read()
            return ""
        except Exception as e:
            print(f"Intonation Analysis Error: {e}")
            return ""
        finally:
            for t in [temp_input, temp_trace]:
                try:
                    if os.path.exists(t):
                        os.remove(t)
                except OSError:
                    pass

    def parse_trace_to_notes(self, trace_data):
        """
        Open JTalkのトレースログから音素とピッチを抽出して、
        タイムライン用の辞書リストに変換する
        """
        notes = []
        if not trace_data:
            return notes

        pattern = re.compile(r'(\d+)-(\d+)\s+([^\s]+)')
        lines = trace_data.split('\n')

        for line in lines:
            line = line.strip()
            match = pattern.match(line)
            if match:
                _start_tick = int(match.group(1))
                _end_tick = int(match.group(2))
                _label_text = match.group(3) if (match.lastindex or 0) >= 3 else ""
                # TODO: label_text を使ったノート変換処理をここに実装する

        return notes
