import { bufferToWav } from './utils/audioEncoder';
import {
  parsePitchBend,
  smoothPitchBendPoints,
  calculateFormantCutoff,
  softClampSemitone
} from './utils/pitchCurve';

export interface CachedSample {
  audioBuffer: AudioBuffer;
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

const sampleCache = new Map<string, CachedSample>();
const inFlightRequests = new Map<string, Promise<CachedSample | null>>();

let sharedDecodeCtx: AudioContext | null = null;
function getSharedDecodeContext(): AudioContext {
  if (!sharedDecodeCtx || sharedDecodeCtx.state === 'closed') {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    sharedDecodeCtx = new AudioCtx();
  }
  return sharedDecodeCtx;
}

export async function fetchSampleWithCache(
  voicebank: string,
  alias: string,
  prevLyric?: string,
  noteNum?: number
): Promise<CachedSample | null> {
  if (isRest(alias)) return null;
  const key = `${voicebank}:${alias}:${prevLyric || ''}:${noteNum || 60}`;
  if (sampleCache.has(key)) {
    return sampleCache.get(key)!;
  }
  if (inFlightRequests.has(key)) {
    return await inFlightRequests.get(key)!;
  }

  const promise = (async (): Promise<CachedSample | null> => {
    try {
      let url = `/api/py/voicebank-sample?name=${encodeURIComponent(voicebank)}&alias=${encodeURIComponent(alias)}`;
      if (prevLyric) {
        url += `&prevLyric=${encodeURIComponent(prevLyric)}`;
      }
      if (noteNum !== undefined) {
        url += `&noteNum=${encodeURIComponent(String(noteNum))}`;
      }

      const res = await fetch(url);
      if (!res.ok) return null;

      const left_blank = parseFloat(res.headers.get('X-Oto-Left-Blank') || '0');
      const fixed_range = parseFloat(res.headers.get('X-Oto-Fixed-Range') || '0');
      const right_blank = parseFloat(res.headers.get('X-Oto-Right-Blank') || '0');
      const preutterance = parseFloat(res.headers.get('X-Oto-Preutterance') || '0');
      const overlap = parseFloat(res.headers.get('X-Oto-Overlap') || '0');
      const baseMidi = parseFloat(res.headers.get('X-Sample-Base-Midi') || '60');

      const arrayBuf = await res.arrayBuffer();
      const ctx = getSharedDecodeContext();
      const audioBuffer = await ctx.decodeAudioData(arrayBuf);

      const item: CachedSample = {
        audioBuffer,
        left_blank,
        fixed_range,
        right_blank,
        preutterance,
        overlap,
        baseMidi
      };

      sampleCache.set(key, item);
      return item;
    } catch (err) {
      console.warn(`Failed to fetch sample ${alias}:`, err);
      return null;
    } finally {
      inFlightRequests.delete(key);
    }
  })();

  inFlightRequests.set(key, promise);
  return await promise;
}

export async function renderStudioOffline(notes: any[], tempo: number, voicebank: string): Promise<string | null> {
  if (!notes || notes.length === 0) return null;

  const sampleRate = 44100;
  const sortedNotes = [...notes].sort((a, b) => a.tick - b.tick);
  const maxTick = sortedNotes.reduce((max, n) => Math.max(max, (n.tick || 0) + (n.length || 480)), 0);
  const totalDurationSec = Math.max((maxTick / 480) * (60 / tempo) + 1.5, 1.0);
  const totalSamples = Math.ceil(sampleRate * totalDurationSec);

  // 1. 必要なサンプルの組み合わせを洗い出す
  interface SampleRequest {
    voicebank: string;
    alias: string;
    prevLyric?: string;
    noteNum: number;
  }
  const sampleKeyMap = new Map<string, SampleRequest>();

  for (let idx = 0; idx < sortedNotes.length; idx++) {
    const n = sortedNotes[idx];
    if (isRest(n.lyric)) continue;
    const lyric = n.lyric || 'あ';
    const prevNote = idx > 0 ? sortedNotes[idx - 1] : null;
    const isContinuous = prevNote && (n.tick - (prevNote.tick + prevNote.length) <= 240);
    const prevLyric = isContinuous ? prevNote.lyric : undefined;
    const pitchMidi = n.noteNum || 60;
    const key = `${voicebank}:${lyric}:${prevLyric || ''}:${pitchMidi}`;
    if (!sampleKeyMap.has(key)) {
      sampleKeyMap.set(key, { voicebank, alias: lyric, prevLyric, noteNum: pitchMidi });
    }
  }

  // 2. サンプルをバッチで先読み
  const requests = Array.from(sampleKeyMap.values());
  const BATCH_SIZE = 8;
  for (let i = 0; i < requests.length; i += BATCH_SIZE) {
    const batch = requests.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(req => fetchSampleWithCache(req.voicebank, req.alias, req.prevLyric, req.noteNum))
    );
  }

  // 3. 各ノートのタイミング情報をリスト化
  interface VoicedNote {
    sample: CachedSample;
    actualStartTime: number;
    noteStartTime: number;
    noteDurationSec: number;
    startOffsetInWav: number;
    cutoffEndSec: number;
    baseRate: number;
    overlapSec: number;
    n: any;
  }
  const voiced: VoicedNote[] = [];

  for (let idx = 0; idx < sortedNotes.length; idx++) {
    const n = sortedNotes[idx];
    if (isRest(n.lyric)) continue;
    const lyric = n.lyric || 'あ';
    const prevNote = idx > 0 ? sortedNotes[idx - 1] : null;
    const isContinuous = prevNote && (n.tick - (prevNote.tick + prevNote.length) <= 240);
    const prevLyric = isContinuous ? prevNote.lyric : undefined;
    const pitchMidi = n.noteNum || 60;

    const sample = await fetchSampleWithCache(voicebank, lyric, prevLyric, pitchMidi);
    if (!sample || !sample.audioBuffer) continue;

    const { left_blank, right_blank, preutterance, overlap, baseMidi } = sample;
    const noteStartTime = (n.tick / 480) * (60 / tempo);
    const noteDurationSec = (n.length / 480) * (60 / tempo);

    const semitoneShift = softClampSemitone(pitchMidi - baseMidi);
    const baseRate = Math.min(4.0, Math.max(0.18, Math.pow(2, semitoneShift / 12)));

    const offsetSec = Math.max(0, left_blank / 1000);
    const preuttSec = Math.max(0, preutterance / 1000);
    const effectivePreuttSec = preuttSec / baseRate;
    const wavDuration = sample.audioBuffer.duration;

    let cutoffEndSec = wavDuration;
    if (right_blank > 0) {
      cutoffEndSec = Math.max(offsetSec + 0.05, wavDuration - (right_blank / 1000));
    } else if (right_blank < 0) {
      cutoffEndSec = Math.max(offsetSec + 0.05, Math.min(wavDuration, offsetSec + Math.abs(right_blank) / 1000));
    }

    const actualStartTime = Math.max(0, noteStartTime - effectivePreuttSec);
    const timeDiff = actualStartTime - (noteStartTime - effectivePreuttSec);
    const startOffsetInWav = Math.min(offsetSec + timeDiff * baseRate, cutoffEndSec - 0.02);

    const overlapSec = Math.max(0.006, Math.min(0.15, (overlap || 10) / 1000 / baseRate));

    voiced.push({
      sample,
      actualStartTime,
      noteStartTime,
      noteDurationSec,
      startOffsetInWav,
      cutoffEndSec,
      baseRate,
      overlapSec,
      n,
    });
  }

  // 4. OfflineAudioContext とマスターバスを用意
  const offlineCtx = new OfflineAudioContext(2, totalSamples, sampleRate);

  const masterCompressor = offlineCtx.createDynamicsCompressor();
  masterCompressor.threshold.setValueAtTime(-6, 0);
  masterCompressor.knee.setValueAtTime(12, 0);
  masterCompressor.ratio.setValueAtTime(4, 0);
  masterCompressor.attack.setValueAtTime(0.003, 0);
  masterCompressor.release.setValueAtTime(0.15, 0);
  const masterGain = offlineCtx.createGain();
  masterGain.gain.setValueAtTime(1.06, 0);
  masterCompressor.connect(masterGain);
  masterGain.connect(offlineCtx.destination);

  // 5. 各ノートをスケジューリング
  for (let i = 0; i < voiced.length; i++) {
    const v = voiced[i];
    const { sample, actualStartTime, noteStartTime, noteDurationSec, startOffsetInWav, cutoffEndSec, baseRate, overlapSec, n } = v;
    const { audioBuffer, fixed_range, preutterance, left_blank } = sample;
    const wavDuration = audioBuffer.duration;
    const offsetSec = Math.max(0, left_blank / 1000);
    const preuttSec = Math.max(0, preutterance / 1000);
    const fixedSec = Math.max(0, fixed_range / 1000);
    const playLen = (preuttSec / baseRate) + noteDurationSec;

    const source = offlineCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.playbackRate.setValueAtTime(baseRate, actualStartTime);

    let formantFilter: BiquadFilterNode | null = null;
    if (n.pbs && n.pbw && n.pby) {
      try {
        const rawPoints = parsePitchBend(n.pbs, n.pbw, n.pby);
        const points = smoothPitchBendPoints(rawPoints);

        formantFilter = offlineCtx.createBiquadFilter();
        formantFilter.type = 'lowpass';
        formantFilter.Q.setValueAtTime(0.707, actualStartTime);
        const initialCutoff = calculateFormantCutoff(sample.baseMidi || 60, points[0]?.semitone || 0);
        formantFilter.frequency.setValueAtTime(initialCutoff, actualStartTime);

        for (const pt of points) {
          const ptTime = noteStartTime + pt.offsetMs / 1000;
          const ptRate = Math.max(0.18, Math.min(4.0, baseRate * Math.pow(2, pt.semitone / 12)));
          const ptCutoff = calculateFormantCutoff(sample.baseMidi || 60, pt.semitone);
          if (ptTime >= 0 && ptTime < totalDurationSec) {
            source.playbackRate.linearRampToValueAtTime(ptRate, ptTime);
            formantFilter.frequency.linearRampToValueAtTime(ptCutoff, ptTime);
          }
        }
      } catch (e) {}
    }

    const maxSampleDur = Math.max(0.04, cutoffEndSec - offsetSec);
    const requiredSampleSec = (startOffsetInWav - offsetSec) + playLen * baseRate;
    if (requiredSampleSec > maxSampleDur + 0.02) {
      const loopStartSec = Math.min(cutoffEndSec - 0.06, offsetSec + Math.max(0.02, fixedSec || preuttSec || 0.05));
      const loopEndSec = Math.min(wavDuration - 0.01, Math.max(loopStartSec + 0.04, cutoffEndSec - 0.01));
      if (loopEndSec > loopStartSec + 0.03) {
        source.loop = true;
        source.loopStart = loopStartSec;
        source.loopEnd = loopEndSec;
      }
    }

    const gainNode = offlineCtx.createGain();
    const volGain = Math.max(0.05, Math.min(1.5, (n.intensity || 120) / 120)) * 0.92;

    const attackEnd = Math.max(actualStartTime + 0.008, actualStartTime + overlapSec);
    gainNode.gain.setValueAtTime(0.0001, actualStartTime);
    gainNode.gain.exponentialRampToValueAtTime(
      Math.max(0.01, volGain),
      Math.min(attackEnd, noteStartTime + noteDurationSec * 0.4)
    );

    const nextNote = voiced[i + 1];
    const naturalReleaseStart = Math.max(noteStartTime + 0.01, noteStartTime + noteDurationSec - 0.012);
    const naturalReleaseEnd = noteStartTime + noteDurationSec + 0.025;
    const releaseStart = nextNote ? Math.min(naturalReleaseStart, nextNote.actualStartTime) : naturalReleaseStart;
    const releaseEnd = nextNote
      ? Math.max(releaseStart + 0.006, Math.min(naturalReleaseEnd, nextNote.actualStartTime + nextNote.overlapSec))
      : naturalReleaseEnd;

    gainNode.gain.setValueAtTime(volGain, Math.max(attackEnd, releaseStart));
    gainNode.gain.exponentialRampToValueAtTime(0.0001, releaseEnd);

    const hpf = offlineCtx.createBiquadFilter();
    hpf.type = 'highpass';
    hpf.frequency.setValueAtTime(80, actualStartTime);
    hpf.Q.setValueAtTime(0.707, actualStartTime);

    const presence = offlineCtx.createBiquadFilter();
    presence.type = 'highshelf';
    presence.frequency.setValueAtTime(6500, actualStartTime);
    presence.gain.setValueAtTime(2.2, actualStartTime);

    source.connect(hpf);
    if (formantFilter) {
      hpf.connect(formantFilter);
      formantFilter.connect(presence);
    } else {
      hpf.connect(presence);
    }
    presence.connect(gainNode);
    gainNode.connect(masterCompressor);

    source.start(actualStartTime, startOffsetInWav);
    source.stop(releaseEnd + 0.03);
  }

  const renderedBuffer = await offlineCtx.startRendering();
  const wavBlob = bufferToWav(renderedBuffer);
  return URL.createObjectURL(wavBlob);
}

export const renderWasm = renderStudioOffline;
