import wave
import numpy as np
import glob
import os
import math

def resample_audio(data, orig_fs, target_fs=44100):
    """
    単純な線形補間でリサンプリング（scipy非依存）
    """
    if orig_fs == target_fs:
        return data

    duration = len(data) / orig_fs
    target_len = int(math.ceil(duration * target_fs))
    # 元のサンプルインデックス（0～len(data)-1）
    orig_indices = np.linspace(0, len(data) - 1, len(data))
    # ターゲットインデックス（0～len(data)-1 の範囲でマッピング）
    target_indices = np.linspace(0, len(data) - 1, target_len)
    resampled = np.interp(target_indices, orig_indices, data).astype(np.int16)
    return resampled


def pack_all_voices():
    base_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../"))
    output_path = os.path.join(base_dir, "src/voice_data.h")
    search_path = os.path.join(base_dir, "assets/official_voices/**/*.wav")

    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    wav_files = glob.glob(search_path, recursive=True)

    print(f"Target Output: {output_path}")
    print(f"Searching in: {search_path}")

    if not wav_files:
        print("Warning: No wav files found. Generating empty header.")
        with open(output_path, 'w', encoding='utf-8') as h:
            h.write("#pragma once\n#include <stdint.h>\n\n")
            h.write('extern "C" void load_embedded_resource'
                    '(const char* phoneme, const int16_t* raw_data, int sample_count);\n\n')
            h.write("inline void register_all_embedded_voices() {}\n")
        return

    with open(output_path, 'w', encoding='utf-8') as h:
        h.write("#pragma once\n#include <stdint.h>\n\n")
        h.write('extern "C" void load_embedded_resource(const char* phoneme, const int16_t* raw_data, int sample_count);\n\n')

        voice_entries = []

        for wav_path in wav_files:
            parts = os.path.normpath(wav_path).split(os.sep)
            folder_name = parts[-2] if len(parts) > 2 else ""
            file_base = os.path.splitext(parts[-1])[0]
            entry_name = f"{folder_name}_{file_base}" if folder_name != "official_voices" else file_base

            safe_id = "".join(f"{ord(c):04x}" for c in entry_name)
            var_name = f"OFFICIAL_VOICE_{safe_id}"

            try:
                with wave.open(wav_path, 'rb') as f:
                    fs = f.getframerate()
                    nch = f.getnchannels()
                    frames = f.readframes(f.getnframes())
                    data = np.frombuffer(frames, dtype=np.int16)

                    if nch == 2:
                        data = data[::2]

                    # エンジンは 44100Hz 固定なのでリサンプリング
                    if fs != 44100:
                        print(f"Resampling {wav_path} from {fs}Hz to 44100Hz")
                        data = resample_audio(data, fs, 44100)

                    # クリッピング（念のため）
                    data = np.clip(data, -32768, 32767).astype(np.int16)

                    h.write(f"// Source: {wav_path} (ID: {entry_name})\n")
                    h.write(f"const int16_t {var_name}[] = {{\n    ")

                    # 15個ずつ改行
                    for i, val in enumerate(data):
                        h.write(f"{val},")
                        if (i + 1) % 15 == 0:
                            h.write("\n    ")

                    h.write("\n};\n")
                    h.write(f"const int {var_name}_LEN = {len(data)};\n\n")

                    voice_entries.append((entry_name, var_name))

            except Exception as e:
                print(f"Error processing {wav_path}: {e}")

        # 登録関数
        h.write("inline void register_all_embedded_voices() {\n")
        for entry_name, var_name in voice_entries:
            h.write(f'    load_embedded_resource("{entry_name}", {var_name}, {var_name}_LEN);\n')
        h.write("}\n")

    print(f"Success: Packed {len(wav_files)} voices from {search_path}")


if __name__ == "__main__":
    pack_all_voices()
