// ============================================================
// wasmEngine.ts
//
// ★設計変更(1回目): 以前はここに Web Audio (OfflineAudioContext) による
// 独自のレンダリング実装 (renderStudioOffline) があり、名前だけ
// "renderWasm" でありながら vose_core.wasm を一切使っていなかった。
//
// ★設計変更(2回目): メインスレッドから直接 execute_render() を ccall() で
// 呼ぶと、WORLD解析(Harvest/CheapTrick/D4C)の重い同期処理でブラウザタブが
// 完全にフリーズし、進捗表示すら更新できず「一生終わらない」ように見える
// 問題があった。実行そのものを voseCoreWorker.ts (Web Worker) へ移し、
// メインスレッドは応答性を保ったまま結果を待つだけにする。
//
// サンプルのfetch/decode/リサンプリング(要Web Audio API)はWorkerでは
// 行えないため、引き続きここ(メインスレッド)で行い、変換済みのPCMだけを
// Workerへ転送する。
// ============================================================

import { parsePitchBend, sampleSemitoneAt, type PitchPoint } from './utils/pitchCurve';
import type { RenderRequestMsg, RenderResponseMsg, WorkerSampleEntry, WorkerNoteEntry } from './voseCoreWorker';

const KFRAME_PERIOD_MS = 5.0; // vose_core.cpp の kFramePeriod と一致させること

// ============================================================
// Worker管理 (1個を使い回す。ページ内で複数回書き出しても再生成しない)
// ============================================================
let worker: Worker | null = null;
let nextRequestId = 1;
const pendingRequests = new Map<
  number,
  { resolve: (wav: ArrayBuffer) => void; reject: (err: Error) => void; onProgress?: (pct: number) => void }
>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./voseCoreWorker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (ev: MessageEvent<RenderResponseMsg>) => {
    const msg = ev.data;
    const pending = pendingRequests.get(msg.requestId);
    if (!pending) return;
    if (msg.type === 'done') {
      pendingRequests.delete(msg.requestId);
      pending.resolve(msg.wav);
    } else if (msg.type === 'error') {
      pendingRequests.delete(msg.requestId);
      pending.reject(new Error(msg.message));
    } else if (msg.type === 'progress') {
      pending.onProgress?.(msg.percent);
    }
  };
  worker.onerror = (ev: ErrorEvent) => {
    // どのリクエストに紐づくか特定できないエラー(Worker自体のロード失敗等)は
    // 保留中の全リクエストを失敗させる
    for (const [id, pending] of pendingRequests) {
      pending.reject(new Error(`Worker error: ${ev.message}`));
      pendingRequests.delete(id);
    }
  };
  return worker;
}

function renderViaWorker(
  samples: WorkerSampleEntry[],
  notes: WorkerNoteEntry[],
  modeFlag: number,
  onProgress?: (pct: number) => void
): Promise<ArrayBuffer> {
  const w = getWorker();
  const requestId = nextRequestId++;
  return new Promise<ArrayBuffer>((resolve, reject) => {
    pendingRequests.set(requestId, { resolve, reject, onProgress });
    const req: RenderRequestMsg = { type: 'render', requestId, samples, notes, modeFlag };
    // pcm16(ArrayBuffer)はTransferableとして転送し、コピーコストを避ける
    w.postMessage(req, samples.map(s => s.pcm16));
  });
}

// ============================================================
// サンプル取得 (ライブプレビューと共通のエンドポイント)
// ============================================================
export interface FetchedSample {
  pcm16: Int16Array; // 44100Hz, モノラル, 16bit PCM (load_embedded_resource用)
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
// 変換してから渡す。(Web Audio APIはWorker内で使えないため、この処理は
// 必ずメインスレッド側で行う必要がある)
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
export async function renderStudioOffline(
  notes: any[],
  tempo: number,
  voicebank: string,
  onProgress?: (pct: number) => void
): Promise<string | null> {
  if (!notes || notes.length === 0) return null;

  const sortedNotes = [...notes].sort((a, b) => a.tick - b.tick);

  // 1. 必要なサンプルの組み合わせを洗い出し、キー(=WASM登録キー)を確定する
  interface NoteWithKey {
    n: any;
    key: string | null; // null = 休符
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
    noteWithKeys.push({ n, key });
  }

  // 2. サンプルをバッチで取得する (ここはメインスレッドでfetch+decodeするので
  //    Web Workerには影響せず、UIは引き続き応答可能)
  const requestEntries = Array.from(uniqueRequests.entries());
  const BATCH_SIZE = 8;
  const workerSamples: WorkerSampleEntry[] = [];
  const resolvedKeys = new Set<string>();
  for (let i = 0; i < requestEntries.length; i += BATCH_SIZE) {
    const batch = requestEntries.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async ([key, req]) => {
        const sample = await fetchSampleForWasm(voicebank, req.alias, req.prevLyric, req.noteNum);
        if (!sample) return; // 解決できなかった歌詞は無音として扱う(スキップ)
        // pcm16.buffer をそのまま渡すとTypedArrayのbyteOffset/lengthがズレる
        // 可能性があるため、確実に単独のArrayBufferへコピーしてから転送する
        const standalone = sample.pcm16.slice().buffer;
        workerSamples.push({ key, pcm16: standalone });
        resolvedKeys.add(key);
      })
    );
  }

  // 3. Workerに渡すNoteEvent情報(ピッチカーブ込み)を構築する
  const voicedNotes = noteWithKeys.filter(nk => nk.key !== null && resolvedKeys.has(nk.key));
  if (voicedNotes.length === 0) {
    console.warn('[wasmEngine] 有効なノートが1つも解決できませんでした。');
    return null;
  }

  const workerNotes: WorkerNoteEntry[] = voicedNotes.map(({ n, key }) => {
    const noteDurationMs = (n.length / 480) * (60000 / tempo);
    const noteMidi = n.noteNum || 60;

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
    return { key: key!, pitchCurveHz };
  });

  // 4. Workerへ委譲してレンダリング実行 (メインスレッド/UIはブロックされない)
  //    mode_flag: 0=通常モード, 1=Pro版(BigVGAN等有効化)
  const wavBuffer = await renderViaWorker(workerSamples, workerNotes, 0, onProgress);
  const blob = new Blob([wavBuffer], { type: 'audio/wav' });
  return URL.createObjectURL(blob);
}

export const renderWasm = renderStudioOffline;
