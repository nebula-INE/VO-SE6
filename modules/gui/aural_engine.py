#aural_engine.py

from __future__ import annotations
from typing import TYPE_CHECKING
import numpy as np
import os
import ctypes
import _ctypes
import platform

if TYPE_CHECKING:
    import onnxruntime as ort  # 型チェック時だけimport（実行時は無視）

try:
    import onnxruntime as _ort  # 実行時はこちら
    ONNX_AVAILABLE = True
except ImportError:
    _ort = None  # type: ignore
    ONNX_AVAILABLE = False

try:
    import onnxruntime as ort
    ONNX_AVAILABLE = True
except ImportError:
    ort = None
    ONNX_AVAILABLE = False


class DynamicsMemoryManager:
    def __init__(self, dll_path):
        self.path = dll_path
        self._handle = ctypes.CDLL(self.path)

        # [プロ仕様] 引数型を明示定義（型不一致によるクラッシュ防止）
        if hasattr(self._handle, "vse_render_audio"):
            self._handle.vse_render_audio.argtypes = [ctypes.POINTER(ctypes.c_float), ctypes.c_int]
            self._handle.vse_render_audio.restype = ctypes.c_void_p

        print(f"Professional Core Loaded: {self.path}")

    def fast_render(self, float_array):
        """
        [Zero-copy] Pythonの配列をコピーせず、メモリアドレスだけをC側に転送する
        """
        if not self._handle:
            return

        data_ptr = float_array.ctypes.data_as(ctypes.POINTER(ctypes.c_float))
        data_len = len(float_array)

        try:
            self._handle.vse_render_audio(data_ptr, data_len)
        except Exception as e:
            print(f"DEBUG: Render Crash Guard: {e}")

    def safe_release_audio(self, audio_ptr):
        """
        [メモリ管理] C言語側でmallocした音声バッファをピンポイントで解放する
        （長時間動作時のメモリリーク対策）
        """
        if audio_ptr and self._handle is not None:
            free_buffer = getattr(self._handle, "vse_free_buffer", None)
            if callable(free_buffer):
                free_buffer(audio_ptr)
                print("C-side audio buffer released.")

    def unload_engine(self):
        """
        DLLを完全にメモリから解放する（キャラ切り替え用）
        terminate_engineの存在確認を行ってからコール（安全対策）
        """
        if self._handle:
            # 存在確認してからC側の内部リソースを解放
            if hasattr(self._handle, "terminate_engine"):
                self._handle.terminate_engine()

            handle_val = self._handle._handle
            if platform.system() == "Windows":
                free_library = getattr(_ctypes, "FreeLibrary", None)
                if callable(free_library):
                    free_library(handle_val)
            else:
                dlclose = getattr(_ctypes, "dlclose", None)
                if callable(dlclose):
                    dlclose(handle_val)

            self._handle = None
            print("Engine Unloaded.")


class AuralAIEngine:
    def __init__(self, model_path="models/aural_dynamics.onnx"):
        self.model_path = model_path
        self.session = None
        self.cache = {}  # [高速化] 一度計算したAIピッチは保存して再利用

        if ONNX_AVAILABLE and os.path.exists(self.model_path):
            try:
                # [最適化] スレッド数を制限してCore i3などの低スペック環境でも安定動作
                sess_options = _ort.SessionOptions()    # type: ignore[union-attr]
                sess_options.intra_op_num_threads = 2
                self.session = _ort.InferenceSession(         # type: ignore[union-attr]
                    self.model_path,
                    sess_options=sess_options,  
                    providers=['CPUExecutionProvider']
                )
                print(f"[AI Core] Inference Engine Online: {self.model_path}")
            except Exception as e:
                print(f"[AI Core] Init Error: {e}")

    def get_baked_pitch(self, note_id, base_f0_array, strength=0.8):
        """
        [ベイク方式 + キャッシュ] 
        一度だけAIに計算させて結果を保存(Bake)する。
        同じnote_idが来たらキャッシュから即レスポンス。
        """
        if note_id in self.cache:
            return self.cache[note_id]

        if not self.session:
            return self._apply_pseudo_ai(base_f0_array)

        input_data = base_f0_array.astype(np.float32).reshape(1, -1, 1)
        delta = self.session.run(None, {"input": input_data})[0]
        delta_arr = np.asarray(delta, dtype=np.float32).reshape(-1)

        final_pitch = base_f0_array + (delta_arr * strength)
        self.cache[note_id] = final_pitch

        return final_pitch

    def generate_emotional_pitch(self, base_f0_array, strength=0.8):
        """
        [キャッシュなし版] 毎回AIで推論して人間らしい『揺れ』を加える。
        note_idを使わないリアルタイム処理向け。
        """
        if not self.session:
            return self._apply_pseudo_ai(base_f0_array)

        input_data = base_f0_array.astype(np.float32).reshape(1, -1, 1)
        delta = self.session.run(None, {"input": input_data})[0]
        delta_arr = np.asarray(delta, dtype=np.float32).reshape(-1)

        return base_f0_array + (delta_arr * strength)  # strengthバグ修正済み

    def _apply_pseudo_ai(self, f0):
        """AIモデルがない時の予備ロジック（5Hzビブラートエミュレーション）"""
        x = np.linspace(0, 10, len(f0))
        return f0 + (np.sin(x * 5) * 2)
