// ============================================================
// voseCoreWorker.ts
//
// execute_render() はWORLD解析(Harvest/CheapTrick/D4C)を含む重い同期処理で、
// メインスレッドのJSから ccall() で直接呼ぶとブラウザタブが完全にフリーズし、
// 進捗表示すら更新できなくなる（「一生終わらない」ように見える原因）。
// ここでWASMモジュールの実行そのものをWeb Workerへ移し、メインスレッドは
// 応答性を保ったまま結果を待てるようにする。
//
// ★重要: このWorkerは type:'module' で生成される前提。モジュールWorker内では
// importScripts() が使えない(仕様上非対応・例外になる)ため、vose_core.js は
// 動的 import() で読み込む。そのためビルド側も -s EXPORT_ES6=1 で
// 正式なESモジュール(`export default createVoseCoreModule`)として
// 出力する必要がある(build_wasm.yml参照)。
//
// 注意: Web WorkerにはDOM(document)もWeb Audio APIも無いため、
// サンプルのfetch/decode/リサンプリングは引き続きメインスレッド(wasmEngine.ts)
// 側で行い、ここには「登録キー＋16bit PCM」と「NoteEvent構築に必要な
// プレーンな値」だけを渡す。
// ============================================================

interface VoseCoreModule {
  ccall: (name: string, retType: string | null, argTypes: string[], args: unknown[]) => unknown;
  setValue: (ptr: number, value: number, type: string) => void;
  stringToUTF8: (str: string, outPtr: number, maxBytes: number) => void;
  lengthBytesUTF8: (str: string) => number;
  _malloc: (size: number) => number;
  _free: (ptr: number) => void;
  addFunction: (fn: (...args: number[]) => number | void, signature: string) => number;
  removeFunction: (ptr: number) => void;
  HEAPU8: Uint8Array;
  HEAPF64: Float64Array;
  FS: {
    readFile: (path: string, opts?: { encoding?: string }) => Uint8Array;
    unlink?: (path: string) => void;
  };
}

declare const self: DedicatedWorkerGlobalScope;

// NoteEvent構造体レイアウト (wasmEngine.tsと同一。vose_core.hのwasm32版オフセット)
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

let modPromise: Promise<VoseCoreModule> | null = null;

async function getModule(): Promise<VoseCoreModule> {
  if (modPromise) return modPromise;
  modPromise = (async () => {
    // vose_core.js はビルド時に生成される実行時アセットであり、TypeScriptの
    // 型解決対象には含まれない(存在しないモジュールとして型エラーになる)ため
    // 明示的に無視する。実行時には -s EXPORT_ES6=1 でビルドされた正式な
    // ESモジュールとして解決される。
    // @ts-ignore
    const mod = await import(/* @vite-ignore */ '/wasm/vose_core.js');
    const createVoseCoreModule = mod.default as (opts?: Record<string, unknown>) => Promise<VoseCoreModule>;
    return createVoseCoreModule({
      locateFile: (path: string) => (path.endsWith('.wasm') ? '/wasm/vose_core.wasm' : path)
    });
  })();
  return modPromise;
}

function allocDoubleArray(mod: VoseCoreModule, values: number[] | null): number {
  if (!values || values.length === 0) return 0;
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

export interface WorkerSampleEntry {
  key: string;
  pcm16: ArrayBuffer; // Int16Array の実体をTransferableで受け取る
}

export interface WorkerNoteEntry {
  key: string;         // load_embedded_resourceに登録したキーと同一(休符なら無視される)
  pitchCurveHz: number[];
  isRest?: boolean;     // true の場合 wav_path=nullptr で登録し、vose_core.cpp側の
                        // 「休符で前ノート参照をリセットする」既存機構を機能させる
}

export interface RenderRequestMsg {
  type: 'render';
  requestId: number;
  samples: WorkerSampleEntry[];
  notes: WorkerNoteEntry[];
  modeFlag: number;
}

export type RenderResponseMsg =
  | { type: 'progress'; requestId: number; percent: number }
  | { type: 'done'; requestId: number; wav: ArrayBuffer }
  | { type: 'error'; requestId: number; message: string };

self.onmessage = async (ev: MessageEvent<RenderRequestMsg>) => {
  const msg = ev.data;
  if (!msg || msg.type !== 'render') return;
  const { requestId, samples, notes, modeFlag } = msg;

  let progressFnPtr = 0;
  const allocatedPtrs: number[] = [];

  try {
    const mod = await getModule();

    // 1. サンプルをWASM側へ登録する
    for (const s of samples) {
      const view = new Int16Array(s.pcm16);
      const pcmPtr = mod._malloc(view.length * 2);
      mod.HEAPU8.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength), pcmPtr);
      mod.ccall('load_embedded_resource', null, ['string', 'number', 'number'], [s.key, pcmPtr, view.length]);
      mod._free(pcmPtr);
    }

    // 2. NoteEvent配列を構築する
    const notesPtr = mod._malloc(notes.length * NOTE_EVENT_SIZE);
    allocatedPtrs.push(notesPtr);

    for (let i = 0; i < notes.length; i++) {
      const { key, pitchCurveHz, isRest } = notes[i];
      const base = notesPtr + i * NOTE_EVENT_SIZE;

      const pitchCurvePtr = allocDoubleArray(mod, pitchCurveHz);
      if (pitchCurvePtr) allocatedPtrs.push(pitchCurvePtr);

      // ★休符は wav_path=nullptr(0) で登録する。vose_core.cpp側の
      // `if (!notes[i].wav_path) { ...; prev_renderable=false; last_ev=nullptr; }`
      // により、休符をまたいだ誤った遷移ブレンドが正しく防止される。
      // (空文字列だと "" というキーで load_embedded_resource 済みかの
      //  検索が走ってしまうため、必ずヌルポインタ自体を渡す)
      const wavPathPtr = isRest ? 0 : allocCString(mod, key);
      if (wavPathPtr) allocatedPtrs.push(wavPathPtr);

      mod.setValue(base + OFF_WAV_PATH, wavPathPtr, 'i32');
      mod.setValue(base + OFF_PITCH_CURVE, pitchCurvePtr, 'i32');
      mod.setValue(base + OFF_PITCH_LENGTH, pitchCurveHz.length, 'i32');
      mod.setValue(base + OFF_GENDER_CURVE, 0, 'i32');
      mod.setValue(base + OFF_TENSION_CURVE, 0, 'i32');
      mod.setValue(base + OFF_BREATH_CURVE, 0, 'i32');
      mod.setValue(base + OFF_VIBRATO_DEPTH_CURVE, 0, 'i32');
      mod.setValue(base + OFF_VIBRATO_RATE_CURVE, 0, 'i32');
      mod.setValue(base + OFF_VIBRATO_CURVE_LENGTH, 0, 'i32');
      mod.setValue(base + OFF_PORTAMENTO_OFFSETS, 0, 'i32');
      mod.setValue(base + OFF_PORTAMENTO_LENGTH, 0, 'i32');
    }

    // 3. レンダリング実行 (execute_render_cancelable で進捗をメインスレッドへ
    //    中継する。ProgressCallback = void(*)(int) をJS関数から生成する)
    const outputPath = '/vose_output.wav';
    progressFnPtr = mod.addFunction((percent: number) => {
      const resp: RenderResponseMsg = { type: 'progress', requestId, percent };
      (self as unknown as Worker).postMessage(resp);
    }, 'vi');

    mod.ccall(
      'execute_render_cancelable',
      null,
      ['number', 'number', 'string', 'number', 'number', 'number'],
      [notesPtr, notes.length, outputPath, modeFlag, progressFnPtr, 0] // cancel_cb=0(nullptr)=キャンセル無し
    );

    const wavBytes = mod.FS.readFile(outputPath, { encoding: 'binary' }) as Uint8Array;
    const wavCopy = new Uint8Array(wavBytes); // WASMヒープ外へコピー
    try { mod.FS.unlink?.(outputPath); } catch (e) { /* ignore */ }

    const resp: RenderResponseMsg = { type: 'done', requestId, wav: wavCopy.buffer };
    (self as unknown as Worker).postMessage(resp, [wavCopy.buffer]);
  } catch (err: any) {
    const resp: RenderResponseMsg = { type: 'error', requestId, message: err?.message || String(err) };
    (self as unknown as Worker).postMessage(resp);
  } finally {
    if (progressFnPtr) {
      try {
        const mod = await getModule();
        mod.removeFunction(progressFnPtr);
        for (const ptr of allocatedPtrs) {
          try { mod._free(ptr); } catch (e) { /* ignore */ }
        }
      } catch (e) { /* ignore */ }
    }
  }
};
