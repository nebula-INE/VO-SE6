import ctypes
from typing import Optional 
import os
import platform
import numpy as np
import tempfile
import shutil
from typing import List, Dict, Any, Callable
try:
    import sounddevice as sd
except Exception:
    sd = None
try:
    import soundfile as sf
except Exception:
    sf = None
try:
    import chardet
except Exception:
    chardet = None


# ==========================================================================
# 1. C言語互換構造体（パラメーターを1つも漏らさずC++へ）
# ==========================================================================
class CNoteEvent(ctypes.Structure):
    _fields_ = [
        ("wav_path", ctypes.c_char_p),
        ("pitch_curve", ctypes.POINTER(ctypes.c_double)),
        ("pitch_length", ctypes.c_int),
        ("gender_curve", ctypes.POINTER(ctypes.c_double)),
        ("tension_curve", ctypes.POINTER(ctypes.c_double)),
        ("breath_curve", ctypes.POINTER(ctypes.c_double)),
        ("vibrato_depth_curve", ctypes.POINTER(ctypes.c_double)),
        ("vibrato_rate_curve", ctypes.POINTER(ctypes.c_double)),
        ("vibrato_curve_length", ctypes.c_int),
    ]

# 🚀 【新規追加】C++側の 8バイトアライメント（24バイト固定長）に完全準拠した構造体定義
class CVoseFrame(ctypes.Structure):
    _pack_ = 8
    _fields_ = [
        ("time", ctypes.c_double),
        ("phoneme", ctypes.c_char * 8),
        ("weight", ctypes.c_double),
    ]


# ==========================================================================
# 2. メインエンジンクラス（削りなし・全機能統合版）
# ==========================================================================
class VO_SE_Engine:
    def __init__(self, voice_lib_dir="voices"):
        self.sample_rate = 44100
        self.lib = self._load_core_library()
        self._temp_refs = []  # C++実行中のメモリ保護用
        self.is_playing = False
        self.stream = None
        self.current_out_data = None  # 現在再生中の全波形データ
        
        # パス解決（開発環境とビルド後の両方に対応）
        base_dir = os.path.dirname(os.path.abspath(__file__))
        self.voice_lib_path = os.path.abspath(os.path.join(base_dir, "..", voice_lib_dir))
        
        # 🚀 【フェーズ3：音素解析・原音設定・C++転送ブリッジの完全統合】
        # refresh_voice_library() が走る前に、受け皿となるパーサー類を確実に実体化
        from modules.data.text_analyzer import TextAnalyzer
        from modules.data.oto_parser import OtoParser
        from modules.bridge.pipeline_bridge import PipelineBridge

        self.text_analyzer = TextAnalyzer()
        self.oto_parser = OtoParser()
        self.pipeline_bridge = PipelineBridge(self.lib)
        
        self.oto_map = {}
        self.refresh_voice_library()

        try:
            from modules.gui.aural_engine import AuralAIEngine
            self.aural_ai = AuralAIEngine()
        except Exception:
            self.aural_ai = None

    def get_audio_devices(self):
        """接続されているオーディオ入出力デバイスのリストを返す"""
        if sd is None:
            return []
        devices = sd.query_devices()
        output_devices = [d['name'] for d in devices if d['max_output_channels'] > 0]
        return output_devices

    def set_output_device(self, device_name):
        """指定されたデバイスを出力先に設定する"""
        if sd is None:
            raise RuntimeError("sounddevice is not available")
        sd.default.device = [None, device_name]  # [入力, 出力]
        print(f"🔈 Output set to: {device_name}")

    def setup_audio_output(self, device_name=None):
        """
        オーディオデバイスを設定する。
        """
        try:
            if sd is None:
                print("Audio backend is unavailable: sounddevice not installed.")
                return
            if device_name:
                sd.default.device[1] = device_name  # 出力デバイスを指定
            device_info = sd.query_devices(sd.default.device[1])
            print(f"✔︎ Audio device set: {device_info['name']}")
        except Exception as e:
            print(f"Device error: {e}")

    def set_voice_library(self, path: str) -> None:
        """音源フォルダを動的に切り替え、oto.ini を再読み込みする"""
        self.voice_lib_path = path
        self.refresh_voice_library()

    def set_oto_data(self, oto_data: list) -> None:
        """oto.ini のパース結果をエンジン側で保持（VCV解決時に使用）"""
        self.oto_data = oto_data

    def prepare_cache(self, notes: list) -> None:
        """再生前に波形の先行キャッシュ（現状はスルーでOK。将来的に最適化）"""
        # スタブ：重い処理を事前に走らせたい場合はここに実装
        pass

    def export_to_wav_v2(self, notes, params, file_path) -> Optional[str]:
        """既存の export_to_wav を呼び出すラッパー（パッチ互換用）"""
        # export_to_wav が None を返す可能性があるので、ファイルパスを返すようにする
        self.export_to_wav(notes, params, file_path)
        return file_path  # 常にファイルパスを返す（成功前提）
        
    def set_tempo(self, tempo: float) -> None:
        """テンポをエンジン内部に保持（現状は何もしないが、将来のDSP用）"""
        self._tempo = float(tempo)

    def _load_core_library(self):
        """OS判別ロード（Win/Mac/Linux対応）"""
        system = platform.system()
        if system == "Windows":
            lib_names = ("vose_core.dll",)
        elif system == "Darwin":
            lib_names = ("libvose_core.dylib", "vose_core.dylib")
        else:
            lib_names = ("libvose_core.so", "vose_core.so")
        
        # 探索候補
        base_dir = os.path.dirname(__file__)
        search_dirs = [
            base_dir,
            os.path.join(base_dir, "bin"),
            os.path.join(os.getcwd(), "bin"),
            os.getcwd(),
        ]
        search_paths = [os.path.join(directory, lib_name) for directory in search_dirs for lib_name in lib_names]
        
        for path in search_paths:
            if os.path.exists(path):
                try:
                    lib = ctypes.CDLL(os.path.abspath(path))
                    
                    # 既存のレンダリング関数のバインド
                    lib.execute_render.argtypes = [
                        ctypes.POINTER(CNoteEvent), 
                        ctypes.c_int, 
                        ctypes.c_char_p,
                        ctypes.c_int,
                    ]
                    
                    # 🚀 【新規追加】タイムライン連続フレーム転送関数のバインド定義
                    if hasattr(lib, "set_vocal_timeline"):
                        lib.set_vocal_timeline.argtypes = [
                            ctypes.POINTER(CVoseFrame),
                            ctypes.c_int
                        ]
                        lib.set_vocal_timeline.restype = None
                    
                    print(f"○ Engine Core Connected: {path}")
                    return lib
                except Exception as e:
                    print(f"Load Error: {e}")
        return None

    # --- 高度な音源スキャン ---
    def refresh_voice_library(self):
        """voicesフォルダを再帰的にスキャン。UTAU音源の階層構造に対応"""
        if not os.path.exists(self.voice_lib_path):
            os.makedirs(self.voice_lib_path, exist_ok=True)
            return
        
        self.oto_map = {}
        for root, _, files in os.walk(self.voice_lib_path):
            # 小文字に統一したファイル名リストを一度だけ作成
            files_lower = [f.lower() for f in files]
            
            # 🚀 【最適化フック】このフォルダ内に oto.ini が存在する場合、フォルダの最初で1度だけロード
            if "oto.ini" in files_lower:
                # 実際のファイル名（大文字小文字を維持した正しいパス）を取得してパース
                target_ini = files[files_lower.index("oto.ini")]
                ini_path = os.path.join(root, target_ini)
                self.oto_parser.load_oto_file(ini_path)

            for file in files:
                if file.lower().endswith(".wav"):
                    lyric = os.path.splitext(file)[0]
                    self.oto_map[lyric] = os.path.abspath(os.path.join(root, file))

    # --- エンコーディング自動判別 ---
    def read_text_safely(self, file_path):
        """USTやoto.iniの文字化けを防ぐ"""
        try:
            with open(file_path, 'rb') as f:
                raw = f.read()
                if chardet is None:
                    return raw.decode("cp932", errors='ignore')
                det = chardet.detect(raw)
                enc = det['encoding'] if det['confidence'] > 0.7 else 'cp932'
                safe_enc = enc if isinstance(enc, str) else "cp932"
                return raw.decode(safe_enc, errors='ignore')
        except Exception:
            return ""

    # --- 核心機能：多重パラメーター・レンダリング ---
    def export_to_wav(
        self,
        notes: List[Any],
        parameters: Dict[str, Any],
        file_path: str,
        mode_flag: int = 0,
        progress_callback: Optional[Callable[[int], None]] = None,
        cancel_check: Optional[Callable[[], bool]] = None,
    ) -> Optional[str]:
        """
        バッチレンダリング対応版 export_to_wav。
        - notes をチャンク分割して C++ execute_render を複数回呼び出す
        - 各チャンク完了後に progress_callback を呼ぶ
        - cancel_check が True を返したら中断
        """
        if not self.lib:
            raise RuntimeError("Engine Core library missing!")

        # soundfile が利用可能かチェック（安全ガード）
        if sf is None:
            print("[VO_SE_Engine] soundfile not available, cannot write WAV.")
            return None

        total = len(notes)
        if total == 0:
            return None

        # 100分割を上限にチャンクサイズを決定（1チャンク最小1ノート）
        chunk_size = max(1, total // 100) if total > 100 else 1

        # テンポラリディレクトリ
        temp_dir = tempfile.mkdtemp(prefix="vose_render_")
        chunk_files = []
        combined_audio = []

        try:
            for start_idx in range(0, total, chunk_size):
                # キャンセルチェック
                if cancel_check and cancel_check():
                    print("[VO_SE_Engine] Render cancelled by user.")
                    return None

                chunk_notes = notes[start_idx:start_idx + chunk_size]
                chunk_count = len(chunk_notes)

                # C++ 構造体配列の生成（既存のロジックを流用）
                c_notes_array = (CNoteEvent * chunk_count)()
                self._temp_refs = []

                for i, note in enumerate(chunk_notes):
                    wav_path = self.oto_map.get(note.lyrics) or self.oto_map.get(note.phonemes)
                    if not wav_path:
                        wav_path = list(self.oto_map.values())[0] if self.oto_map else ""

                    res = 128
                    p_curve = self._get_sampled_curve(parameters.get("Pitch", []), note, res, is_pitch=True).astype(np.float64)
                    g_curve = self._get_sampled_curve(parameters.get("Gender", []), note, res).astype(np.float64)
                    t_curve = self._get_sampled_curve(parameters.get("Tension", []), note, res).astype(np.float64)
                    b_curve = self._get_sampled_curve(parameters.get("Breath", []), note, res).astype(np.float64)
                    vibrato_depth_curve = np.zeros(res, dtype=np.float64)
                    vibrato_rate_curve = np.zeros(res, dtype=np.float64)

                    self._temp_refs.extend([
                        p_curve, g_curve, t_curve, b_curve,
                        vibrato_depth_curve, vibrato_rate_curve
                    ])

                    c_notes_array[i].wav_path = wav_path.encode('utf-8')
                    c_notes_array[i].pitch_curve = p_curve.ctypes.data_as(ctypes.POINTER(ctypes.c_double))
                    c_notes_array[i].gender_curve = g_curve.ctypes.data_as(ctypes.POINTER(ctypes.c_double))
                    c_notes_array[i].tension_curve = t_curve.ctypes.data_as(ctypes.POINTER(ctypes.c_double))
                    c_notes_array[i].breath_curve = b_curve.ctypes.data_as(ctypes.POINTER(ctypes.c_double))
                    c_notes_array[i].vibrato_depth_curve = vibrato_depth_curve.ctypes.data_as(ctypes.POINTER(ctypes.c_double))
                    c_notes_array[i].vibrato_rate_curve = vibrato_rate_curve.ctypes.data_as(ctypes.POINTER(ctypes.c_double))
                    c_notes_array[i].pitch_length = res
                    c_notes_array[i].vibrato_curve_length = res

                # チャンク用の一時WAVパス
                chunk_path = os.path.join(temp_dir, f"chunk_{start_idx:06d}.wav")

                # C++ エンジン実行
                self.lib.execute_render(
                    c_notes_array,
                    chunk_count,
                    chunk_path.encode('utf-8'),
                    mode_flag
                )
                # メモリ保護リストをクリア
                self._temp_refs = []

                # レンダリング結果を読み込む
                if os.path.exists(chunk_path):
                    data, sr = sf.read(chunk_path)
                    combined_audio.append(data)
                    chunk_files.append(chunk_path)

                # 進捗更新
                if progress_callback:
                    processed = min(start_idx + chunk_count, total)
                    percent = int((processed / total) * 100)
                    progress_callback(percent)

            # 全チャンクを結合して最終出力
            if not combined_audio:
                print("[VO_SE_Engine] No audio data rendered.")
                return None

            final_audio = np.concatenate(combined_audio)
            sf.write(file_path, final_audio, 44100)

            print(f"[VO_SE_Engine] Render complete: {file_path}")
            return file_path

        except Exception as e:
            print(f"[VO_SE_Engine] Render error: {e}")
            return None

        finally:
            # テンポラリディレクトリの後片付け
            try:
                shutil.rmtree(temp_dir)
            except Exception:
                pass
                
    def _get_sampled_curve(self, events, note, res, is_pitch=False):
        curve = np.zeros(res, dtype=np.float32)
        default_val = 60.0 if is_pitch else 0.5
        if not events:
            return curve + default_val

        times = np.linspace(note.start_time, note.start_time + note.duration, res)
        event_times = [p.time for p in events]
        event_values = [p.value for p in events]
        
        curve = np.interp(times, event_times, event_values).astype(np.float32)
        
        if is_pitch:
            curve += float(note.note_number)
            curve = 440.0 * (2.0 ** ((curve - 69.0) / 12.0))
            if self.aural_ai is not None:
                note_id = id(note)
                curve = self.aural_ai.get_baked_pitch(note_id, curve)
            
        return curve

    def get_current_rms(self):
        """再生中の『本物の波形』から現在の音量を計算して返す"""
        if not self.is_playing or self.current_out_data is None:
            return 0.0

        try:
            get_playback_time = getattr(self, "get_playback_time", None)
            raw_playback = get_playback_time() if callable(get_playback_time) else 0.0
            playback_time = float(raw_playback) if isinstance(raw_playback, (int, float)) else 0.0
            curr_sample = int(playback_time * 44100)
            chunk = self.current_out_data[curr_sample : curr_sample + 256]
            if len(chunk) == 0:
                return 0.0
            
            rms = np.sqrt(np.mean(chunk**2))
            return min(rms * 5.0, 1.0)
        except Exception:
            return 0.0
    
    # --- 再生制御 ---
    def play(self, filepath):
        if sd is None or sf is None:
            print("Audio playback is unavailable: sounddevice/soundfile not installed.")
            return
        if filepath and os.path.exists(filepath):
            data, fs = sf.read(filepath)
            sd.play(data, fs)

    def stop(self):
        if sd is None:
            return
        sd.stop()
