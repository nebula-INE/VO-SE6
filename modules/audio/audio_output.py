# audio_output.py

import platform
import queue
import sys

try:
    import sounddevice as sd
except Exception:  # 依存がない環境でも UI 初期化を継続する
    sd = None


class AudioOutput:
    def __init__(self, sample_rate=44100, block_size=256, max_buffer_blocks=64):
        """
        ■ 【フェーズ2：再設計】非同期プル型ストリーミング・オーディオ出力クラス
        
        max_buffer_blocks: 先読みして蓄積しておくオーディオブロックの最大数。
                           256サンプル * 64ブロック = 約0.37秒分のセーフティバッファを常時維持。
        """
        self.sample_rate = sample_rate
        self.block_size = block_size
        self.stream = None
        self.is_playing = False
        self.engine_callback = None  # C言語エンジンへの橋渡し用
        
        # 【スレッド隔離層】超高優先度のオーディオスレッドと、重い合成スレッドを完全に分離するFIFOキュー
        self.buffer_queue = queue.Queue(maxsize=max_buffer_blocks)
        self.producer_thread = None
        
        # OSに合わせた最適なデバイス設定
        self._initialize_device()

    def _initialize_device(self):
        """OSごとの最適なオーディオドライバを自動選択"""
        if sd is None:
            print("VO-SE: sounddevice が未導入のため、オーディオ出力は無効化されます。")
            return
        if platform.system() == "Windows":
            best_idx = self._get_best_device_for_windows()
            if best_idx is not None:
                sd.default.device = best_idx
                dev_info = sd.query_devices(best_idx)
                print(f"VO-SE: Windows高速出力デバイス選択 -> {dev_info['name']}")
        elif platform.system() == "Darwin":  # macOS
            # Apple Silicon (M1/M2/M3/M4/M5) は Core Audio で極めて低遅延
            print("VO-SE: macOS Core Audioで初期化 (Apple Silicon Optimized)")

    def _get_best_device_for_windows(self):
        """Windows環境で低遅延なドライバ(ASIO > WASAPI)を優先的に探す"""
        if sd is None:
            return None
        devices = sd.query_devices()
        
        # 1. ASIO (DAWなどで使われる最強の低遅延ドライバ)
        for i, dev in enumerate(devices):
            if "ASIO" in dev['name']:
                return i
                
        # 2. WASAPI (Windows標準の低遅延モード)
        for i, dev in enumerate(devices):
            if "WASAPI" in dev['name'] and dev['max_output_channels'] > 0:
                return i
                
        return None

    def start(self, engine_callback=None):
        """ストリームを開始し、先行バッファリングスレッドを動かす""" 
        if sd is None:
            raise RuntimeError("sounddevice is not available")
            
        self.engine_callback = engine_callback
        self.is_playing = True
        
        # 過去の残余バッファを完全にフラッシュ
        while not self.buffer_queue.empty():
            try:
                self.buffer_queue.get_nowait()
            except queue.Empty:
                break

        # [1] バックグラウンド音声「生産（Producer）」スレッドを起動
        # C++の重い合成処理をこのスレッドに隔離し、事前にキューへ波形を詰め込ませます
        import threading
        self.producer_thread = threading.Thread(target=self._audio_producer_loop, daemon=True)
        self.producer_thread.start()

        # [2] オーディオ出力ストリームの起動（PortAudio側リアルタイムスレッドの開始）
        if self.stream is None:
            self.stream = sd.OutputStream(
                samplerate=self.sample_rate,
                blocksize=self.block_size,
                channels=1,
                dtype='float32',
                callback=self._audio_callback
            )
            self.stream.start()

    def stop(self):
        """再生を停止し、ストリームとスレッドを安全に破棄する"""
        self.is_playing = False
        
        # オーディオストリームの完全停止
        if self.stream:
            try:
                self.stream.stop()
                self.stream.close()
            except Exception as e:
                print(f"[Warning] Error closing audio stream: {e}")
            self.stream = None
            
        # 生産者スレッドの合流待ち（タイムアウト付きでゾンビ化を防止）
        if self.producer_thread and self.producer_thread.is_alive():
            self.producer_thread.join(timeout=0.2)
            self.producer_thread = None
            
        # キューの完全クリーンアップ
        while not self.buffer_queue.empty():
            try:
                self.buffer_queue.get_nowait()
            except queue.Empty:
                break

    def _audio_producer_loop(self):
        """
        【バックグラウンド供給】C++エンジンから随時波形データを先読み（プル）し、
        キューに事前充填（プリバッファリング）する高効率ループ。
        """
        if "numpy" in sys.modules:
            np = sys.modules["numpy"]
        else:
            import numpy as np

        while self.is_playing:
            if self.engine_callback:
                # 1ブロック分のテンポラリバッファ（shape: [block_size, 1]）を確保
                block_buffer = np.zeros((self.block_size, 1), dtype=np.float32)
                
                try:
                    # 既存のエンジンコールバックを安全に実行（ここでC++処理やLock待ちが発生してもOK）
                    self.engine_callback(block_buffer, self.block_size)
                except Exception as e:
                    print(f"[Error] Engine callback failed in producer loop: {e}")
                    block_buffer.fill(0)

                try:
                    # キューにブロックを投入。満杯の場合は空きが出るまでスレッドをブロック（待機）させて同期
                    self.buffer_queue.put(block_buffer, timeout=0.1)
                except queue.Full:
                    continue
            else:
                import time
                time.sleep(0.01)

    def _audio_callback(self, outdata, frames, time_info, status):
        """
        【サウンドカード要求コールバック】OSネイティブの最優先スレッド。
        一切の演算、I/O、重いLock待ちを排除し、キューからメモリコピーするだけの超軽量設計。
        """
        if status:
            if status.output_underflow:
                # 合成が間に合わなかった場合のハードウェア警告を検知
                print("[Warning] Audio Output Underflow! (Buffer starvation)")

        if not self.is_playing:
            outdata.fill(0)
            return

        try:
            # 事前生成済みの音声ブロックをノンブロッキングで即座に取得
            block = self.buffer_queue.get_nowait()
            outdata[:] = block
            
        except queue.Empty:
            # 万が一キューが空（アンダーラン）の時は、激しいブツブツ音（DCオフセットクリップ）を防ぐため、
            # 安全にゼロ（無音）で埋めてバッファをフェールセーフ
            outdata.fill(0)

    def get_latency(self):
        """現在の実測遅延（秒）を取得"""
        if self.stream:
            return self.stream.latency
        return 0
