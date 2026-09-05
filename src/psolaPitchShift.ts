// psolaPitchShift.ts
//
// 簡易 TD-PSOLA (Time-Domain Pitch-Synchronous OverLap-Add) による
// フォルマント保持ピッチシフト。
//
// これまでの wasmEngine.ts は AudioBufferSourceNode.playbackRate だけで
// ピッチを作っていたため、音高を上げるほどフォルマント(声道共鳴=声質)まで
// 一緒に引き伸ばされ「別人の声」に聞こえていた。
//
// この実装は:
//  1. 元サンプルの基本周期(ピッチ周期)を自己相関で推定
//  2. その周期を単位に「グレイン」(2周期分・Hann窓)を切り出す
//  3. グレインの中身(=フォルマント/声質)は一切変えずに、
//     グレインを配置する間隔だけを目標ピッチ比に合わせて詰め直す(OLA)
// ことで、ピッチだけを変え声質を保持する。
//
// オフライン(OfflineAudioContext)でのバウンス処理を前提にしており、
// リアルタイム制約は無いためグレイン単位のループ処理で十分実用速度。

export interface PsolaOptions {
  /** 探索する基本周波数の下限(Hz)。低い声/低音ノート向けに広めに */
  minF0Hz?: number;
  /** 探索する基本周波数の上限(Hz) */
  maxF0Hz?: number;
  /** 基本周期を再推定する間隔(ms)。ピッチの時間変化(ビブラート等)に追従するため */
  reanalysisIntervalMs?: number;
}

const DEFAULT_OPTS: Required<PsolaOptions> = {
  minF0Hz: 70,
  maxF0Hz: 800,
  reanalysisIntervalMs: 80,
};

function hannWindow(length: number): Float32Array {
  const w = new Float32Array(length);
  if (length <= 1) {
    w.fill(1);
    return w;
  }
  for (let i = 0; i < length; i++) {
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (length - 1));
  }
  return w;
}

/**
 * 正規化自己相関によるシンプルな基本周期(サンプル数)推定。
 * 無声区間やノイズ区間では信頼できるピークが出ないため、
 * その場合は前回値や中央値にフォールバックさせて呼び出し側で扱う。
 */
function estimatePeriodSamples(
  data: Float32Array,
  sampleRate: number,
  centerSample: number,
  windowSamples: number,
  minF0: number,
  maxF0: number
): number | null {
  const minPeriod = Math.max(2, Math.floor(sampleRate / maxF0));
  const maxPeriod = Math.max(minPeriod + 1, Math.floor(sampleRate / minF0));

  const start = Math.max(0, centerSample - Math.floor(windowSamples / 2));
  const end = Math.min(data.length, start + windowSamples);
  const n = end - start;
  if (n < maxPeriod * 2) return null;

  let bestPeriod = -1;
  let bestScore = 0.15; // 閾値未満(=無声/無相関)は不採用にしてフォールバックさせる

  for (let period = minPeriod; period <= maxPeriod; period++) {
    let sum = 0;
    let normA = 0;
    let normB = 0;
    const count = n - period;
    for (let i = 0; i < count; i++) {
      const a = data[start + i];
      const b = data[start + i + period];
      sum += a * b;
      normA += a * a;
      normB += b * b;
    }
    const denom = Math.sqrt(normA * normB) + 1e-9;
    const score = sum / denom;
    if (score > bestScore) {
      bestScore = score;
      bestPeriod = period;
    }
  }

  return bestPeriod > 0 ? bestPeriod : null;
}

/**
 * TD-PSOLAでピッチと出力長(再生に使う実時間)を同時に変更し、
 * フォルマント(声質)を保持した AudioBuffer を返す。
 *
 * これまでの wasmEngine.ts は `source.playbackRate = baseRate` 一発で
 * 「ピッチを変える」のと「録音サンプルの消費速度を変える(preutterance/overlap
 * などのタイミング計算に必要)」を同時にやっていたため、ピッチと声質(フォルマント)
 * が連動してズレていた。
 *
 * この関数は両者を分離する:
 *  - `targetLengthSamples` … 何秒分の実時間に伸縮するか(今までのbaseRateによる
 *    時間圧縮/伸長と同じ役割。preutterance/overlapのタイミング計算はそのまま使える)
 *  - `pitchRatio` … 目標ピッチ比。フォルマントはこの比の影響を受けない。
 *
 * @param ctx                AudioContext / OfflineAudioContext (createBuffer用)
 * @param srcBuffer          元サンプル(必要な範囲を事前に切り出しておく)
 * @param pitchRatio         目標ピッチ比 (例: 1オクターブ上なら 2.0, 半音なら 2^(1/12))
 * @param targetLengthSamples 出力の長さ(サンプル数)。省略時は入力と同じ長さ
 *                             (=ピッチだけ変えて時間は変えない、ビブラート等の
 *                             微小ピッチ補正用途に使う)
 */
export function psolaPitchAndTimeShiftBuffer(
  ctx: BaseAudioContext,
  srcBuffer: AudioBuffer,
  pitchRatio: number,
  targetLengthSamples?: number,
  opts: PsolaOptions = {}
): AudioBuffer {
  const o = { ...DEFAULT_OPTS, ...opts };
  const sampleRate = srcBuffer.sampleRate;
  const outLen = targetLengthSamples ?? srcBuffer.length;

  // ピッチ比がほぼ1、かつ長さもほぼ同じならPSOLA処理自体をスキップ
  if (Math.abs(pitchRatio - 1) < 0.003 && outLen === srcBuffer.length) {
    return srcBuffer;
  }

  const numCh = srcBuffer.numberOfChannels;
  const outBuffer = ctx.createBuffer(numCh, outLen, sampleRate);
  // 解析マークは入力の再生速度(=時間伸縮比)に合わせて進める。
  // timeRatio > 1 なら「元の音より長く伸ばす」= 解析マークは出力より遅く進む。
  const timeRatio = outLen / srcBuffer.length;

  const reanalysisHop = Math.max(
    64,
    Math.floor((o.reanalysisIntervalMs / 1000) * sampleRate)
  );

  for (let ch = 0; ch < numCh; ch++) {
    const src = srcBuffer.getChannelData(ch);
    const out = new Float32Array(outLen);
    const weight = new Float32Array(outLen);

    // フォールバック用: 全体を通した粗いデフォルト周期
    const globalPeriod =
      estimatePeriodSamples(
        src,
        sampleRate,
        Math.floor(src.length / 2),
        Math.min(src.length, reanalysisHop * 4),
        o.minF0Hz,
        o.maxF0Hz
      ) ?? Math.floor(sampleRate / 220); // 見つからなければA3付近を仮定

    let period = globalPeriod;
    let lastReanalysisMark = -Infinity;
    let synthMark = 0;

    // 安全弁: 極端に短い周期や無限ループを防止
    const minPeriod = Math.max(2, Math.floor(sampleRate / o.maxF0Hz));

    while (synthMark < outLen) {
      // 出力上の位置(synthMark)を、時間伸縮比(timeRatio)を使って元波形上の
      // 対応位置(analysisMark)に写像する。timeRatio=1なら従来通り同じ位置。
      const analysisMark = Math.min(
        src.length - 1,
        Math.round(synthMark / timeRatio)
      );

      if (analysisMark - lastReanalysisMark >= reanalysisHop || lastReanalysisMark < 0) {
        const p = estimatePeriodSamples(
          src,
          sampleRate,
          analysisMark,
          reanalysisHop * 3,
          o.minF0Hz,
          o.maxF0Hz
        );
        if (p !== null) period = p;
        lastReanalysisMark = analysisMark;
      }

      // グレイン(周期波形)は元波形からそのまま切り出す = フォルマントは不変。
      const grainHalf = period;
      const grainLen = grainHalf * 2;
      const window = hannWindow(grainLen);
      const grainStart = analysisMark - grainHalf;

      for (let i = 0; i < grainLen; i++) {
        const srcIdx = grainStart + i;
        if (srcIdx < 0 || srcIdx >= src.length) continue;
        const outIdx = synthMark - grainHalf + i;
        if (outIdx < 0 || outIdx >= outLen) continue;
        const w = window[i];
        out[outIdx] += src[srcIdx] * w;
        weight[outIdx] += w;
      }

      // 合成マークの進み幅 = 元周期を「時間伸縮」と「ピッチ比」の両方で調整。
      // - timeRatioで割る: 出力が元より長ければ、同じ本数の周期をより広い
      //   区間に配って時間を伸ばす(逆に短ければ詰める)
      // - pitchRatioで割る: ピッチを上げるほど周期間隔を詰める
      const synthPeriod = Math.max(
        minPeriod,
        Math.round((period * timeRatio) / pitchRatio)
      );
      synthMark += synthPeriod;
    }

    // オーバーラップ加算の正規化(窓の重なりで音量が変動しないように)
    for (let i = 0; i < outLen; i++) {
      out[i] = weight[i] > 1e-6 ? out[i] / weight[i] : out[i];
    }

    outBuffer.copyToChannel(out, ch);
  }

  return outBuffer;
}

/**
 * ピッチだけを変え、長さは入力と同じに保つ簡易版。
 * ノート単位のベースピッチは psolaPitchAndTimeShiftBuffer で焼き込み、
 * こちらはビブラート/ピッチベンドなど小さい揺れの補正に使う想定
 * (揺れ幅が小さければ formant のズレも知覚できないレベルに収まる)。
 */
export function psolaPitchShiftBuffer(
  ctx: BaseAudioContext,
  srcBuffer: AudioBuffer,
  pitchRatio: number,
  opts: PsolaOptions = {}
): AudioBuffer {
  return psolaPitchAndTimeShiftBuffer(
    ctx,
    srcBuffer,
    pitchRatio,
    srcBuffer.length,
    opts
  );
}
