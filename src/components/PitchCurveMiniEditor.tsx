// PitchCurveMiniEditor.tsx
//
// 右パネルのインスペクターに置く、選択中ノート専用のピッチベンド編集UI。
// タッチ/タップ（Pointer Events）に対応し、時間軸（横）・音高（縦）の拡大縮小（Zoom In / Out）、
// 高さの拡張、モーダル拡大表示機能を搭載。

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { PitchPoint, parsePitchBend, serializePitchBend } from '../utils/pitchCurve';
import { ZoomIn, ZoomOut, RotateCcw, Maximize2, Minimize2, ChevronDown, Plus } from 'lucide-react';

interface PitchCurveMiniEditorProps {
  pbs: string;
  pbw: string;
  pby: string;
  /** ノートの長さ(ticks)。横軸の表示範囲を決めるのに使う */
  noteLengthTicks: number;
  tempo: number;
  onChange: (next: { pbs: string; pbw: string; pby: string }) => void;
}

const BASE_WIDTH = 252;
const BASE_HEIGHT = 108;
const PAD_X = 16;

function roundTo(v: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  return Math.round(v * f) / f;
}

export default function PitchCurveMiniEditor({
  pbs,
  pbw,
  pby,
  noteLengthTicks,
  tempo,
  onChange,
}: PitchCurveMiniEditorProps) {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // 拡大縮小（Zoom）状態
  const [zoomX, setZoomX] = useState<number>(1.0); // 1.0x, 1.5x, 2.0x, 3.0x, 4.0x
  const [semitoneRange, setSemitoneRange] = useState<number>(6); // ±6, ±3, ±1.5, ±12半音
  const [isExpandedHeight, setIsExpandedHeight] = useState<boolean>(false); // 108px <-> 180px
  const [isModalOpen, setIsModalOpen] = useState<boolean>(false); // 全画面モーダル拡大

  // 長押し(Long Press)による「ノードを追加」ボタンポップアップ表示状態
  const [addNodeMenu, setAddNodeMenu] = useState<{
    x: number;
    y: number;
    offsetMs: number;
    semitone: number;
  } | null>(null);

  // マルチタッチ・長押しタイマー管理
  const longPressTimerRef = useRef<NodeJS.Timeout | null>(null);
  const touchPinchRef = useRef<{ dist: number; initialZoom: number } | null>(null);
  const lastTapTimeRef = useRef<number>(0);
  const startPointerPosRef = useRef<{ x: number; y: number } | null>(null);

  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [selectedPointIndex, setSelectedPointIndex] = useState<number | null>(null);

  const points = useMemo(() => parsePitchBend(pbs, pbw, pby), [pbs, pbw, pby]);

  const noteLengthMs = useMemo(() => {
    const msPerTick = 60000 / (tempo || 120) / 480;
    return Math.max(200, noteLengthTicks * msPerTick);
  }, [noteLengthTicks, tempo]);

  // アスペクト比計算用の実効サイズ
  const actualWidth = Math.round(BASE_WIDTH * zoomX);
  const actualHeight = isExpandedHeight ? 180 : BASE_HEIGHT;

  // 表示範囲: 全ノードおよびノート長さに応じて自動動的拡張
  const maxNodeMs = useMemo(() => {
    if (points.length === 0) return 0;
    return Math.max(...points.map((p) => p.offsetMs));
  }, [points]);

  const minNodeMs = useMemo(() => {
    if (points.length === 0) return 0;
    return Math.min(...points.map((p) => p.offsetMs));
  }, [points]);

  const effectiveMaxMs = Math.max(noteLengthMs, maxNodeMs);
  const effectiveMinMs = Math.min(0, minNodeMs);

  const viewMinMs = effectiveMinMs - Math.max(50, noteLengthMs * 0.15);
  const viewMaxMs = effectiveMaxMs + Math.max(100, noteLengthMs * 0.2);

  const msToX = useCallback(
    (ms: number) => PAD_X + ((ms - viewMinMs) / (viewMaxMs - viewMinMs)) * (actualWidth - PAD_X * 2),
    [viewMinMs, viewMaxMs, actualWidth]
  );
  const xToMs = useCallback(
    (x: number) => viewMinMs + ((x - PAD_X) / (actualWidth - PAD_X * 2)) * (viewMaxMs - viewMinMs),
    [viewMinMs, viewMaxMs, actualWidth]
  );
  const semitoneToY = useCallback(
    (s: number) => actualHeight / 2 - (s / semitoneRange) * (actualHeight / 2 - 8),
    [actualHeight, semitoneRange]
  );
  const yToSemitone = useCallback(
    (y: number) => (-(y - actualHeight / 2) / (actualHeight / 2 - 8)) * semitoneRange,
    [actualHeight, semitoneRange]
  );

  const commit = (next: PitchPoint[]) => {
    const sorted = [...next].sort((a, b) => a.offsetMs - b.offsetMs);
    onChange(serializePitchBend(sorted));
  };

  // ズーム操作ハンドラ
  const handleZoomIn = () => setZoomX((prev) => Math.min(4.0, roundTo(prev + 0.5, 1)));
  const handleZoomOut = () => setZoomX((prev) => Math.max(1.0, roundTo(prev - 0.5, 1)));
  const handleResetZoom = () => {
    setZoomX(1.0);
    setSemitoneRange(6);
    setIsExpandedHeight(false);
  };

  // 2本指ピンチ操作 (Pinch-to-zoom) ハンドラ
  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      const dist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
      touchPinchRef.current = { dist, initialZoom: zoomX };
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 2 && touchPinchRef.current) {
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      const currentDist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
      const ratio = currentDist / touchPinchRef.current.dist;
      const nextZoom = Math.max(1.0, Math.min(4.0, roundTo(touchPinchRef.current.initialZoom * ratio, 2)));
      setZoomX(nextZoom);
    }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (e.touches.length < 2) {
      touchPinchRef.current = null;
    }
  };

  // ホイール / トラックパッド ズーム
  const handleWheelZoom = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      e.preventDefault();
      const delta = e.deltaY < 0 ? 0.2 : -0.2;
      setZoomX((prev) => Math.max(1.0, Math.min(4.0, roundTo(prev + delta, 1))));
    }
  };

  // タップ/ポインターダウンでドラッグ開始
  const handlePointerDownPoint = (index: number) => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (e.button === 2) return;

    const target = e.currentTarget as HTMLElement;
    try {
      target.setPointerCapture(e.pointerId);
    } catch (err) {}

    setDraggingIndex(index);
    setSelectedPointIndex(index);
  };

  // ドラッグ移動 (タッチ/マウス共通、スクロール補正付き)
  const handlePointerMove = (e: React.PointerEvent) => {
    if (draggingIndex === null || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const scrollLeft = scrollContainerRef.current ? scrollContainerRef.current.scrollLeft : 0;
    const x = e.clientX - rect.left + scrollLeft;
    const y = e.clientY - rect.top;

    const next = points.map((p, i) => {
      if (i !== draggingIndex) return p;
      const newMs = Math.round(xToMs(Math.max(PAD_X, Math.min(actualWidth - PAD_X, x))));
      const newSemitone = roundTo(
        Math.max(-semitoneRange, Math.min(semitoneRange, yToSemitone(Math.max(8, Math.min(actualHeight - 8, y))))),
        2
      );
      return { offsetMs: newMs, semitone: newSemitone };
    });
    commit(next);
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch (err) {}
    setDraggingIndex(null);
  };

  // 空白位置タップ/ダブルタップ/長押しで制御点を追加
  const handleCanvasPointerDown = (e: React.PointerEvent, modalMode: boolean = false) => {
    // 既存ノード要素の場合は長押しタイマーを開始しない
    const isNodeElem = (e.target as HTMLElement).closest('[data-node-handle="true"]');
    if (isNodeElem) return;

    setAddNodeMenu(null);
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    if (e.button === 2) return; // 右クリック

    const container = containerRef.current;
    if (!container || draggingIndex !== null) return;

    const rect = container.getBoundingClientRect();
    const scrollLeft = scrollContainerRef.current ? scrollContainerRef.current.scrollLeft : 0;
    const x = e.clientX - rect.left + scrollLeft;
    const y = e.clientY - rect.top;

    const offsetMs = Math.round(xToMs(x));
    const semitone = roundTo(yToSemitone(y), 2);

    startPointerPosRef.current = { x: e.clientX, y: e.clientY };

    // 長押しタイマー (380ms)
    longPressTimerRef.current = setTimeout(() => {
      setAddNodeMenu({
        x: Math.max(50, Math.min(actualWidth - 50, x)),
        y: Math.max(20, Math.min(actualHeight - 20, y)),
        offsetMs,
        semitone,
      });
      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        try { navigator.vibrate(40); } catch (_) {}
      }
    }, 380);
  };

  const handleCanvasPointerMoveWithLongPress = (e: React.PointerEvent, modalMode: boolean = false) => {
    if (!modalMode) handlePointerMove(e);

    if (startPointerPosRef.current) {
      const dx = Math.abs(e.clientX - startPointerPosRef.current.x);
      const dy = Math.abs(e.clientY - startPointerPosRef.current.y);
      if (dx > 8 || dy > 8) {
        if (longPressTimerRef.current) {
          clearTimeout(longPressTimerRef.current);
          longPressTimerRef.current = null;
        }
      }
    }
  };

  const handleCanvasPointerUpWithLongPress = (e: React.PointerEvent, modalMode: boolean = false) => {
    if (!modalMode) handlePointerUp(e);
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const handleCanvasTap = (e: React.PointerEvent | React.MouseEvent) => {
    if (!containerRef.current || draggingIndex !== null) return;

    // ダブルタップ検出 (1.0x ↔ 2.0x 切替)
    const now = Date.now();
    if (now - lastTapTimeRef.current < 280) {
      setZoomX((prev) => (prev > 1.2 ? 1.0 : 2.0));
      lastTapTimeRef.current = 0;
      return;
    }
    lastTapTimeRef.current = now;

    const rect = containerRef.current.getBoundingClientRect();
    const scrollLeft = scrollContainerRef.current ? scrollContainerRef.current.scrollLeft : 0;
    const x = e.clientX - rect.left + scrollLeft;
    const y = e.clientY - rect.top;

    // 既存の制御点との距離をチェック (24px以内のタップなら新ノード追加ではなく既存ノード選択)
    let closestIndex = -1;
    let minDistance = 24;

    points.forEach((p, idx) => {
      const px = msToX(p.offsetMs);
      const py = semitoneToY(p.semitone);
      const dist = Math.hypot(x - px, y - py);
      if (dist < minDistance) {
        minDistance = dist;
        closestIndex = idx;
      }
    });

    if (closestIndex >= 0) {
      setSelectedPointIndex(closestIndex);
      return;
    }

    const offsetMs = Math.round(xToMs(x));
    const semitone = roundTo(yToSemitone(y), 2);

    const newPoint: PitchPoint = { offsetMs, semitone };
    const nextPoints = [...points, newPoint].sort((a, b) => a.offsetMs - b.offsetMs);
    commit(nextPoints);

    const newIndex = nextPoints.findIndex((p) => p.offsetMs === offsetMs && p.semitone === semitone);
    if (newIndex >= 0) setSelectedPointIndex(newIndex);
  };

  // ツールバーから明示的にノードを追加
  const handleAddNodeFromToolbar = () => {
    const midMs = Math.round(noteLengthMs / 2);
    let targetMs = midMs;
    while (points.some((p) => Math.abs(p.offsetMs - targetMs) < 20)) {
      targetMs += 30;
    }
    const newPoint: PitchPoint = { offsetMs: targetMs, semitone: 0 };
    const nextPoints = [...points, newPoint].sort((a, b) => a.offsetMs - b.offsetMs);
    commit(nextPoints);
    const newIndex = nextPoints.findIndex((p) => p.offsetMs === targetMs && p.semitone === 0);
    if (newIndex >= 0) setSelectedPointIndex(newIndex);
  };

  // ノード削除
  const handleDeletePoint = (index: number) => (e: React.SyntheticEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (index === 0 || points.length <= 1) return;
    commit(points.filter((_, i) => i !== index));
    setSelectedPointIndex(null);
  };

  const pathD = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${msToX(p.offsetMs).toFixed(1)} ${semitoneToY(p.semitone).toFixed(1)}`)
    .join(' ');

  const noteStartX = msToX(0);
  const noteEndX = msToX(noteLengthMs);
  const zeroY = semitoneToY(0);

  const activePoint = selectedPointIndex !== null && points[selectedPointIndex] ? points[selectedPointIndex] : null;

  const renderCanvasContent = (modalMode: boolean = false) => {
    const curWidth = modalMode ? 460 : actualWidth;
    const curHeight = modalMode ? 260 : actualHeight;
    const curMsToX = (ms: number) => PAD_X + ((ms - viewMinMs) / (viewMaxMs - viewMinMs)) * (curWidth - PAD_X * 2);
    const curSemitoneToY = (s: number) => curHeight / 2 - (s / semitoneRange) * (curHeight / 2 - 12);
    const curPathD = points
      .map((p, i) => `${i === 0 ? 'M' : 'L'} ${curMsToX(p.offsetMs).toFixed(1)} ${curSemitoneToY(p.semitone).toFixed(1)}`)
      .join(' ');

    return (
      <div
        ref={modalMode ? undefined : containerRef}
        className="relative bg-slate-950 border border-slate-800 rounded-md select-none touch-none overflow-hidden cursor-crosshair shrink-0"
        style={{ width: `${curWidth}px`, height: `${curHeight}px` }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onWheel={handleWheelZoom}
        onPointerMove={(e) => handleCanvasPointerMoveWithLongPress(e, modalMode)}
        onPointerUp={(e) => handleCanvasPointerUpWithLongPress(e, modalMode)}
        onPointerCancel={(e) => handleCanvasPointerUpWithLongPress(e, modalMode)}
        onPointerDown={(e) => {
          handleCanvasPointerDown(e, modalMode);
          if (!modalMode && (e.target as HTMLElement).tagName !== 'circle' && !(e.target as HTMLElement).closest('[data-node-handle="true"]')) {
            handleCanvasTap(e);
          }
        }}
        onContextMenu={(e) => e.preventDefault()}
      >
        <svg width={curWidth} height={curHeight} viewBox={`0 0 ${curWidth} ${curHeight}`} className="w-full h-full pointer-events-none">
          {/* 0半音の基準線 */}
          <line x1={0} y1={curSemitoneToY(0)} x2={curWidth} y2={curSemitoneToY(0)} stroke="#334155" strokeWidth={1} strokeDasharray="3,3" />
          {/* ノートの範囲を示す帯 */}
          <rect
            x={curMsToX(0)}
            y={0}
            width={Math.max(0, curMsToX(noteLengthMs) - curMsToX(0))}
            height={curHeight}
            fill="#22d3ee"
            fillOpacity={0.06}
          />
          <line x1={curMsToX(0)} y1={0} x2={curMsToX(0)} y2={curHeight} stroke="#0e7490" strokeWidth={1} strokeDasharray="2,2" />

          {/* カーブ本体 */}
          <path d={curPathD} fill="none" stroke="#22d3ee" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        </svg>

        {/* 制御ノード */}
        {points.map((p, i) => {
          const cx = curMsToX(p.offsetMs);
          const cy = curSemitoneToY(p.semitone);
          const isDragging = draggingIndex === i;
          const isSelected = selectedPointIndex === i;

          return (
            <div
              key={i}
              data-node-handle="true"
              className="absolute transform -translate-x-1/2 -translate-y-1/2 cursor-grab active:cursor-grabbing touch-none flex items-center justify-center z-10 pointer-events-auto"
              style={{
                left: `${cx}px`,
                top: `${cy}px`,
                width: '36px',
                height: '36px',
              }}
              onPointerDown={handlePointerDownPoint(i)}
              onContextMenu={handleDeletePoint(i)}
            >
              <div
                className={`rounded-full transition-transform duration-75 shadow-md border ${
                  isDragging
                    ? 'w-4 h-4 bg-white border-cyan-400 ring-4 ring-cyan-400/50 scale-125'
                    : isSelected
                    ? 'w-3.5 h-3.5 bg-cyan-300 border-cyan-500 ring-2 ring-cyan-400/50'
                    : i === 0
                    ? 'w-2.5 h-2.5 bg-slate-100 border border-cyan-600'
                    : 'w-2 h-2 bg-slate-200 border-slate-600'
                }`}
              />
            </div>
          );
        })}

        {/* 長押し(Long-Press)で表示される「ノードを追加」ボタンポップアップ */}
        {addNodeMenu && !modalMode && (
          <div
            className="absolute z-30 transform -translate-x-1/2 -translate-y-1/2 animate-in fade-in zoom-in-95 duration-150 pointer-events-auto"
            style={{
              left: `${addNodeMenu.x}px`,
              top: `${addNodeMenu.y}px`,
            }}
          >
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                const newPoint: PitchPoint = { offsetMs: addNodeMenu.offsetMs, semitone: addNodeMenu.semitone };
                const nextPoints = [...points, newPoint].sort((a, b) => a.offsetMs - b.offsetMs);
                commit(nextPoints);
                const newIndex = nextPoints.findIndex((p) => p.offsetMs === addNodeMenu.offsetMs && p.semitone === addNodeMenu.semitone);
                if (newIndex >= 0) setSelectedPointIndex(newIndex);
                setAddNodeMenu(null);
              }}
              className="bg-cyan-400 hover:bg-cyan-300 active:scale-95 text-slate-950 font-bold px-3 py-1.5 rounded-full shadow-2xl border border-white text-[11px] flex items-center space-x-1.5 whitespace-nowrap cursor-pointer transition ring-2 ring-cyan-500/50"
            >
              <Plus className="w-3.5 h-3.5 stroke-[3]" />
              <span>ノードを追加 ({addNodeMenu.semitone >= 0 ? `+${addNodeMenu.semitone.toFixed(2)}` : addNodeMenu.semitone.toFixed(2)}st)</span>
            </button>
          </div>
        )}

        {/* タップ中のノード値ポップアップ */}
        {activePoint && selectedPointIndex !== null && (
          <div
            className="absolute transform -translate-x-1/2 -translate-y-full mb-1 pointer-events-none z-20"
            style={{
              left: `${Math.max(35, Math.min(curWidth - 35, curMsToX(activePoint.offsetMs)))}px`,
              top: `${Math.max(22, curSemitoneToY(activePoint.semitone))}px`,
            }}
          >
            <div className="bg-slate-900/95 border border-cyan-500/60 text-cyan-200 text-[10px] font-mono px-1.5 py-0.5 rounded shadow backdrop-blur-sm flex items-center space-x-1 whitespace-nowrap">
              <span>{activePoint.semitone >= 0 ? `+${activePoint.semitone.toFixed(2)}` : activePoint.semitone.toFixed(2)}st</span>
              <span className="text-slate-500">|</span>
              <span>{activePoint.offsetMs}ms</span>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-2">
      {/* ズーム＆表示制御ツールバー */}
      <div className="flex items-center justify-between bg-slate-950 border border-slate-800 rounded px-2 py-1 text-[10px]">
        {/* 時間軸ズーム (横) */}
        <div className="flex items-center space-x-1">
          <button
            type="button"
            onClick={handleZoomOut}
            disabled={zoomX <= 1.0}
            className="p-1 rounded bg-slate-900 hover:bg-slate-800 text-slate-300 disabled:opacity-30"
            title="時間軸を縮小"
          >
            <ZoomOut className="w-3 h-3" />
          </button>
          <span className="font-mono text-cyan-400 font-bold min-w-[34px] text-center">
            {Math.round(zoomX * 100)}%
          </span>
          <button
            type="button"
            onClick={handleZoomIn}
            disabled={zoomX >= 3.5}
            className="p-1 rounded bg-slate-900 hover:bg-slate-800 text-slate-300 disabled:opacity-30"
            title="時間軸を拡大"
          >
            <ZoomIn className="w-3 h-3" />
          </button>
        </div>

        {/* 縦軸レンジ選択 */}
        <div className="flex items-center space-x-1">
          <span className="text-slate-500">レンジ:</span>
          <select
            value={semitoneRange}
            onChange={(e) => setSemitoneRange(parseFloat(e.target.value))}
            className="bg-slate-900 border border-slate-700 text-cyan-300 rounded px-1 py-0.5 text-[10px]"
          >
            <option value={1.5}>±1.5st (超精密)</option>
            <option value={3}>±3st (精密)</option>
            <option value={6}>±6st (標準)</option>
            <option value={12}>±12st (広域)</option>
            <option value={24}>±24st (超広域)</option>
          </select>
        </div>

        {/* リセット・追加 & モーダル拡大 */}
        <div className="flex items-center space-x-1">
          <button
            type="button"
            onClick={handleAddNodeFromToolbar}
            className="flex items-center space-x-1 px-1.5 py-0.5 rounded bg-cyan-950 border border-cyan-700/60 text-cyan-300 hover:bg-cyan-900 active:scale-95 transition"
            title="ノードを追加"
          >
            <Plus className="w-3 h-3 stroke-[3]" />
            <span className="font-bold text-[9px]">ノード</span>
          </button>
          <div className="flex items-center space-x-0.5 bg-slate-900 border border-slate-800 rounded px-1">
            <button
              type="button"
              onClick={() => {
                if (scrollContainerRef.current) scrollContainerRef.current.scrollBy({ left: -150, behavior: 'smooth' });
              }}
              className="px-1 text-[10px] text-slate-300 hover:text-white"
              title="左へスクロール"
            >
              ◀
            </button>
            <button
              type="button"
              onClick={() => {
                if (scrollContainerRef.current) scrollContainerRef.current.scrollBy({ left: 150, behavior: 'smooth' });
              }}
              className="px-1 text-[10px] text-slate-300 hover:text-white"
              title="右へスクロール"
            >
              ▶
            </button>
          </div>
          <button
            type="button"
            onClick={handleResetZoom}
            className="p-1 rounded bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-slate-200"
            title="ズームリセット"
          >
            <RotateCcw className="w-3 h-3" />
          </button>
          <button
            type="button"
            onClick={() => setIsModalOpen(true)}
            className="p-1 rounded bg-cyan-950/80 border border-cyan-500/40 text-cyan-300 hover:bg-cyan-900"
            title="全画面拡大表示"
          >
            <Maximize2 className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* スクロール可能キャンバスエリア */}
      <div
        ref={scrollContainerRef}
        className="w-full overflow-x-auto overflow-y-hidden border border-slate-800 rounded-md bg-slate-950 scrollbar-thin scrollbar-thumb-slate-700"
      >
        {renderCanvasContent(false)}
      </div>

      {/* タップ補助・高さ切替・ワンタップ削除操作エリア */}
      <div className="flex items-center justify-between text-[10px] text-slate-400">
        <button
          type="button"
          onClick={() => setIsExpandedHeight(!isExpandedHeight)}
          className="text-cyan-400 hover:text-cyan-300 underline"
        >
          {isExpandedHeight ? '標準の高さに戻す (108px)' : 'キャンバス高さを拡大 (180px)'}
        </button>

        <span className="text-[9px] text-slate-500 hidden sm:inline">
          💡 2本指ピンチ / ダブルタップで拡大縮小
        </span>

        {selectedPointIndex !== null && selectedPointIndex > 0 && (
          <button
            type="button"
            onClick={handleDeletePoint(selectedPointIndex)}
            className="px-2 py-0.5 bg-red-950/60 hover:bg-red-900/80 border border-red-500/40 text-red-300 rounded text-[10px] transition"
          >
            選択中の点を削除
          </button>
        )}
      </div>

      {/* 全画面/大画面モーダル拡大表示 */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/90 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-cyan-500/40 rounded-xl p-4 max-w-lg w-full space-y-3 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-2">
              <h3 className="text-xs font-bold text-cyan-300 flex items-center space-x-1.5">
                <Maximize2 className="w-4 h-4 text-cyan-400" />
                <span>ピッチカーブ高精度拡大編集</span>
              </h3>
              <button
                type="button"
                onClick={() => setIsModalOpen(false)}
                className="text-slate-400 hover:text-white p-1 rounded bg-slate-800"
              >
                ✕
              </button>
            </div>

            <p className="text-[11px] text-slate-400">
              画面全体でノード（制御点）をタップ・ドラッグして微調整できます。
            </p>

            <div className="flex justify-center bg-slate-950 p-2 rounded-lg border border-slate-800">
              {renderCanvasContent(true)}
            </div>

            <div className="flex justify-end space-x-2 pt-2 border-t border-slate-800">
              <button
                type="button"
                onClick={() => setIsModalOpen(false)}
                className="px-4 py-1.5 bg-cyan-600 hover:bg-cyan-500 text-slate-950 font-bold rounded-md text-xs shadow"
              >
                完了
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


