// ============================================================
// wasmEngine.ts
//
// ★設計変更: 以前はここに Web Audio (OfflineAudioContext) による
// 独自のレンダリング実装 (renderStudioOffline) があり、名前だけ
// "renderWasm" でありながら vose_core.wasm を一切使っていなかった。
// これがライブプレビュー(App.tsx)・書き出し(このファイル)・
// Python/ネイティブ版(vose_core.cpp)の3系統がバラバラに実装され、
// 同じ種類のバグを何度も別々に直す羽目になっていた根本原因だった。
//
// ここでは実際に vose_core.wasm の execute_render() を呼び出し、
// エンジンを1本化する。サンプル取得(/api/py/voicebank-sample)は
// 既存のライブプレビューと共通のエンドポイントをそのまま使う。
// ============================================================

import { parsePitchBend, sampleSemitoneAt, type PitchPoint } from './utils/pitchCurve';

// ============================================================
// WASMモジュールのロード
//
// ビルド時に -s MODULARIZE=1 -s EXPORT_NAME="createVoseCoreModule" を
// 付与している前提(build_wasm.yml参照)。グローバルにスクリプトタグで
// 読み込み、生成されたファクトリ関数を呼び出してインスタンス化する。
// ============================================================
declare global {
  interface Window {
    createVoseCoreModule?: (opts?: Record<string, unknown>) => Promise<VoseCoreModule>;
  }
}

interface VoseCoreModule {
  ccall: (name: string, retType: string | null, argTypes: string[], args: unknown[]) => unknown;
  cwrap: (name: string, retType: string | null, argTypes: string[]) => (...args: unknown[]) => unknown;
  getValue: (ptr: number, type: string) => number;
  setValue: (ptr: number, value: number, type: string) => void;
  stringToUTF8: (str: string, outPtr: number, maxBytes: number) => void;
  lengthBytesUTF8: (str: string) => number;
  _malloc: (size: number) => number;
  _free: (ptr: number) => void;
  HEAPU8: Uint8Array;
  HEAP32: Int32Array;
  HEAPF64: Float64Array;
  FS: {
    readFile: (path: string, opts?: { encoding?: string }) => Uint8Array;
    unlink?: (path: string) => void;
  };
}

let modulePromise: Promise<VoseCoreModule> | null = null;

async function loadVoseCoreModule(): Promise<VoseCoreModule> {
  if (modulePromise) return modulePromise;

  modulePromise = (async () => {
    if (!window.createVoseCoreModule) {
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement('script');
        script.src = '/wasm/vose_core.js';
        script.onload = () => resolve();
        script.onerror = () =>
          reject(new Error('vose_core.js の読み込みに失敗しました (/wasm/vose_core.js を確認してください)'));
        document.head.appendChild(script);
      });
    }
    if (!window.createVoseCoreModule) {
      throw new Error(
        'createVoseCoreModule が見つかりません。vose_core.js が -s MODULARIZE=1 ' +
        '-s EXPORT_NAME="createVoseCoreModule" でビルドされているか確認してください。'
      );
    }
    return window.createVoseCoreModule({
      locateFile: (path: string) => (path.endsWith('.wasm') ? '/wasm/vose_core.wasm' : path)
    });
  })();

  return modulePromise;
}

// ============================================================
// NoteEvent 構造体レイアウト (include/vose_core.h と1バイトも違わないこと)
//
// ★重要: Emscripten の既定ターゲットは wasm32 であり、ポインタは4バイト。
// ネイティブ64bitビルド(.dll/.so、Pythonのctypes側)とはオフセットが
// 異なる点に注意 (#pragma pack(push, 8) は上限であり、全フィールドが
// ポインタ or int = 4バイトなので実質4バイト境界で詰まる)。
//
//   const char* wav_path;             offset  0
//   double*     pitch_curve;          offset  4
//   int         pitch_length;         offset  8
//   double*     gender_curve;         offset 12
//   double*     tension_curve;        offset 16
//   double*     breath_curve;         offset 20
//   double*     vibrato_depth_curve;  offset 24
//   double*     vibrato_rate_curve;   offset 28
//   int         vibrato_curve_length; offset 32
//   double*     portamento_offsets;   offset 36
//   int         portamento_length;    offset 40
//   sizeof(NoteEvent) = 44
// ============================================================
const NOTE_EVENT_SIZE = 44;
const OFF_WAV_PATH = 0;
const OFF_PITCH_CURVE = 4;
const OFF_PITCH_LENGTH = 8;
const OFF_GENDER_CURVE = 12;
const OFF_TENSION_CURVE = 16;
const OFF_BREATH_CURVE = 20;
const OFF_VIBRATO_DEPTH_CURVE = 24;
const OFF_VIBRATO_RATE_CURVE = 28;
const OFF_VIBRATO_CURVE_LENGTH = 32;
const OFF_PORTAMENTO_OFFSETS = 36;
const OFF_PORTAMENTO_LENGTH = 40;

const KFRAME_PERIOD_MS = 5.0; // vose_core.cpp の kFramePeriod と一致させること

// ============================================================
// WASMメモリ確保ヘルパー
// ============================================================
function allocDoubleArray(mod: VoseCoreModule, values: number[] | null): number {
  if (!values || values.length === 0) return 0; // nullptr
  const ptr = mod._malloc(values.length * 8);
  mod.HEAPF64.set(Float64Array.from(values), ptr / 8);
  return ptr;
}

function allocCString(mod: VoseCoreModule, str: string): number {
  const bytes = mod.lengthBytesUTF8(str) + 1;
  const ptr = mod._malloc(bytes);
  mod.stringToUTF8(str, ptr, bytes);
  return ptr;
}

// ============================================================
// サンプル取得 (ライブプレビューと共通のエンドポイント)
// ============================================================
export interface FetchedSample {
  pcm16: Int16Array;   // 44100Hz, モノラル, 16bit PCM (load_embedded_resource用)
  left_blank: number;
  fixed_range: number;
  right_blank: number;
  preutterance: number;
  overlap: number;
  baseMidi: number;
}

const REST_LYRICS_SET = new Set(['r', 'r_', '息', 'br', 'pau', 'sil', '吸', '', ' ', '　', '休', '・', '-', 'ー', '~']);

export function isRest(lyric?: string): boolean {
  if (!lyric) return true;
  const l = lyric.trim().toLowerCase();
  return REST_LYRICS_SET.has(l);
}

const sampleCache = new Map<string, FetchedSample | null>();
const inFlightRequests = new Map<string, Promise<FetchedSample | null>>();

let sharedDecodeCtx: AudioContext | null = null;
function getSharedDecodeContext(): AudioContext {
  if (!sharedDecodeCtx || sharedDecodeCtx.state === 'closed') {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    sharedDecodeCtx = new AudioCtx();
  }
  return sharedDecodeCtx;
}

// load_embedded_resource は固定サンプルレート(44100Hz、vose_core.cppのkFs)前提。
// decodeAudioDataの結果は環境依存のレートになりうるため、必ず44100Hzモノラルへ
// 変換してから渡す。
async function resampleTo44100Mono(buffer: AudioBuffer): Promise<Float32Array> {
  const targetRate = 44100;
  if (buffer.sampleRate === targetRate && buffer.numberOfChannels === 1) {
    return buffer.getChannelData(0).slice();
  }
  const offline = new OfflineAudioContext(1, Math.ceil(buffer.duration * targetRate) + 1, targetRate);
  const src = offline.createBufferSource();
  src.buffer = buffer; // 複数chでも offline.destination がモノラルなので自動ダウンミックスされる
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0).slice();
}

function floatTo16BitPCM(float32: Float32Array): Int16Array {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

async function fetchSampleForWasm(
  voicebank: string,
  alias: string,
  prevLyric?: string,
  noteNum?: number
): Promise<FetchedSample | null> {
  if (isRest(alias)) return null;
  const key = `${voicebank}:${alias}:${prevLyric || ''}:${noteNum || 60}`;
  if (sampleCache.has(key)) return sampleCache.get(key)!;
  if (inFlightRequests.has(key)) return inFlightRequests.get(key)!;

  const promise = (async (): Promise<FetchedSample | null> => {
    try {
      let url = `/api/py/voicebank-sample?name=${encodeURIComponent(voicebank)}&alias=${encodeURIComponent(alias)}`;
      if (prevLyric) url += `&prevLyric=${encodeURIComponent(prevLyric)}`;
      if (noteNum !== undefined) url += `&noteNum=${encodeURIComponent(String(noteNum))}`;

      const res = await fetch(url);
      if (!res.ok) {
        sampleCache.set(key, null);
        return null;
      }

      const left_blank = parseFloat(res.headers.get('X-Oto-Left-Blank') || '0');
      const fixed_range = parseFloat(res.headers.get('X-Oto-Fixed-Range') || '0');
      const right_blank = parseFloat(res.headers.get('X-Oto-Right-Blank') || '0');
      const preutterance = parseFloat(res.headers.get('X-Oto-Preutterance') || '0');
      const overlap = parseFloat(res.headers.get('X-Oto-Overlap') || '0');
      const baseMidi = parseFloat(res.headers.get('X-Sample-Base-Midi') || '60');

      const arrayBuf = await res.arrayBuffer();
      const ctx = getSharedDecodeContext();
      const audioBuffer = await ctx.decodeAudioData(arrayBuf);
      const monoFloat = await resampleTo44100Mono(audioBuffer);
      const pcm16 = floatTo16BitPCM(monoFloat);

      const item: FetchedSample = { pcm16, left_blank, fixed_range, right_blank, preutterance, overlap, baseMidi };
      sampleCache.set(key, item);
      return item;
    } catch (err) {
      console.warn(`[wasmEngine] サンプル取得失敗 alias='${alias}':`, err);
      sampleCache.set(key, null);
      return null;
    } finally {
      inFlightRequests.delete(key);
    }
  })();

  inFlightRequests.set(key, promise);
  return promise;
}

function midiToHz(midi: number): number {
  return 440.0 * Math.pow(2.0, (midi - 69) / 12.0);
}

// ============================================================
// メインのレンダリング関数
// ============================================================
export async function renderStudioOffline(notes: any[], tempo: number, voicebank: string): Promise<string | null> {
  if (!notes || notes.length === 0) return null;

  const mod = await loadVoseCoreModule();
  const sortedNotes = [...notes].sort((a, b) => a.tick - b.tick);

  // 1. 必要なサンプルの組み合わせを洗い出し、キー(=WASM登録キー)を確定する
  interface NoteWithKey {
    n: any;
    key: string | null; // null = 休符
    prevLyric?: string;
  }
  const noteWithKeys: NoteWithKey[] = [];
  const uniqueRequests = new Map<string, { alias: string; prevLyric?: string; noteNum: number }>();

  for (let idx = 0; idx < sortedNotes.length; idx++) {
    const n = sortedNotes[idx];
    if (isRest(n.lyric)) {
      noteWithKeys.push({ n, key: null });
      continue;
    }
    const lyric = n.lyric || 'あ';
    const prevNote = idx > 0 ? sortedNotes[idx - 1] : null;
    const isContinuous = prevNote && (n.tick - (prevNote.tick + prevNote.length) <= 240);
    const prevLyric = isContinuous ? prevNote.lyric : undefined;
    const noteNum = n.noteNum || 60;
    const key = `${voicebank}:${lyric}:${prevLyric || ''}:${noteNum}`;
    if (!uniqueRequests.has(key)) {
      uniqueRequests.set(key, { alias: lyric, prevLyric, noteNum });
    }
    noteWithKeys.push({ n, key, prevLyric });
  }

  // 2. サンプルをバッチで取得し、取得できたものだけWASMへ登録する
  const requestEntries = Array.from(uniqueRequests.entries());
  const BATCH_SIZE = 8;
  const resolvedKeys = new Set<string>();
  for (let i = 0; i < requestEntries.length; i += BATCH_SIZE) {
    const batch = requestEntries.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async ([key, req]) => {
        const sample = await fetchSampleForWasm(voicebank, req.alias, req.prevLyric, req.noteNum);
        if (!sample) return; // 解決できなかった歌詞は無音として扱う(スキップ)
        const pcmPtr = mod._malloc(sample.pcm16.length * 2);
        mod.HEAPU8.set(new Uint8Array(sample.pcm16.buffer, sample.pcm16.byteOffset, sample.pcm16.byteLength), pcmPtr);
        mod.ccall('load_embedded_resource', null, ['string', 'number', 'number'], [key, pcmPtr, sample.pcm16.length]);
        mod._free(pcmPtr); // load_embedded_resource内部でコピー保持される前提(vose_core.cppのg_voice_db.put)
        resolvedKeys.add(key);
      })
    );
  }

  // 3. NoteEvent配列をWASMメモリ上に構築する
  const allocatedPtrs: number[] = []; // 最後にまとめて解放する

  const voicedNotes = noteWithKeys.filter(nk => nk.key !== null && resolvedKeys.has(nk.key));
  if (voicedNotes.length === 0) {
    console.warn('[wasmEngine] 有効なノートが1つも解決できませんでした。');
    return null;
  }

  const notesPtr = mod._malloc(voicedNotes.length * NOTE_EVENT_SIZE);
  allocatedPtrs.push(notesPtr);

  for (let i = 0; i < voicedNotes.length; i++) {
    const { n, key } = voicedNotes[i];
    const base = notesPtr + i * NOTE_EVENT_SIZE;
    const noteDurationMs = (n.length / 480) * (60000 / tempo);
    const noteMidi = n.noteNum || 60;

    // ピッチカーブ: PBS/PBW/PBYがあればそれを反映した絶対Hz値を
    // kFramePeriod(5ms)刻みで構築する。無ければノート自身のMIDI音高で一定。
    let points: PitchPoint[] | null = null;
    if (n.pbs && n.pbw && n.pby) {
      try {
        points = parsePitchBend(n.pbs, n.pbw, n.pby);
      } catch (e) {
        points = null;
      }
    }
    const numFrames = Math.max(1, Math.round(noteDurationMs / KFRAME_PERIOD_MS));
    const pitchCurveHz: number[] = new Array(numFrames);
    for (let j = 0; j < numFrames; j++) {
      const tMs = j * KFRAME_PERIOD_MS;
      const semitone = points ? sampleSemitoneAt(points, tMs) : 0;
      pitchCurveHz[j] = midiToHz(noteMidi) * Math.pow(2, semitone / 12);
    }
    const pitchCurvePtr = allocDoubleArray(mod, pitchCurveHz);
    if (pitchCurvePtr) allocatedPtrs.push(pitchCurvePtr);

    const wavPathPtr = allocCString(mod, key!);
    allocatedPtrs.push(wavPathPtr);

    mod.setValue(base + OFF_WAV_PATH, wavPathPtr, 'i32');
    mod.setValue(base + OFF_PITCH_CURVE, pitchCurvePtr, 'i32');
    mod.setValue(base + OFF_PITCH_LENGTH, numFrames, 'i32');
    // gender/tension/breath は現状UI未接続のためnullptr(=デフォルト値でエンジン側処理)
    mod.setValue(base + OFF_GENDER_CURVE, 0, 'i32');
    mod.setValue(base + OFF_TENSION_CURVE, 0, 'i32');
    mod.setValue(base + OFF_BREATH_CURVE, 0, 'i32');
    // ビブラートはnullptrにしてエンジン内蔵の自動ビブラート(apply_vibrato)に任せる
    mod.setValue(base + OFF_VIBRATO_DEPTH_CURVE, 0, 'i32');
    mod.setValue(base + OFF_VIBRATO_RATE_CURVE, 0, 'i32');
    mod.setValue(base + OFF_VIBRATO_CURVE_LENGTH, 0, 'i32');
    // portamento_offsetsは使わず、pitch_curve側に直接ベンドを焼き込んでいるためnullptr
    mod.setValue(base + OFF_PORTAMENTO_OFFSETS, 0, 'i32');
    mod.setValue(base + OFF_PORTAMENTO_LENGTH, 0, 'i32');
  }

  // 4. レンダリング実行
  const outputPath = '/vose_output.wav';

  try {
    // mode_flag: 0 = 通常モード(★要確認: vose_core.cpp側の定義と食い違いがないか)
    mod.ccall(
      'execute_render',
      null,
      ['number', 'number', 'string', 'number'],
      [notesPtr, voicedNotes.length, outputPath, 0]
    );

    const wavBytes = mod.FS.readFile(outputPath, { encoding: 'binary' }) as Uint8Array;
    const wavCopy = new Uint8Array(wavBytes); // WASMヒープ外の独立したコピーにする
    const blob = new Blob([wavCopy], { type: 'audio/wav' });
    return URL.createObjectURL(blob);
  } finally {
    // 5. WASMメモリを解放する
    for (const ptr of allocatedPtrs) {
      try { mod._free(ptr); } catch (e) { /* ignore */ }
    }
    try { mod.FS.unlink?.(outputPath); } catch (e) { /* ignore */ }
  }
}

export const renderWasm = renderStudioOffline;
