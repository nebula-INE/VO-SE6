import React from 'react';
import { Layers, Plus, Volume2, VolumeX, Eye, EyeOff, Music, Trash2, Copy, Sliders, ChevronDown, ChevronRight, Disc, Upload } from 'lucide-react';

export interface Track {
  id: string;
  name: string;
  type: 'vocal' | 'wave';
  voicebank?: string;
  notes: any[];
  volume: number; // 0.0 ~ 1.2
  pan?: number; // -1.0 ~ 1.0
  isMuted: boolean;
  isSolo: boolean;
  color?: string;
  audioUrl?: string;
}

export interface MultiTrackPanelProps {
  tracks: Track[];
  currentTrackId: string;
  onSelectTrack: (trackId: string) => void;
  onAddTrack: (type: 'vocal' | 'wave') => void;
  onDuplicateTrack: (trackId: string) => void;
  onDeleteTrack: (trackId: string) => void;
  onUpdateTrack: (trackId: string, patch: Partial<Track>) => void;
  showGhostNotes: boolean;
  setShowGhostNotes: (show: boolean) => void;
  customVoicebanks: { name: string; aliasCount: number; hasVcv: boolean }[];
  onImportProject?: () => void;
}

const TRACK_COLORS = [
  '#06b6d4', // Cyan
  '#8b5cf6', // Purple
  '#ec4899', // Pink
  '#10b981', // Emerald
  '#f59e0b', // Amber
  '#3b82f6', // Blue
];

export const MultiTrackPanel: React.FC<MultiTrackPanelProps> = ({
  tracks,
  currentTrackId,
  onSelectTrack,
  onAddTrack,
  onDuplicateTrack,
  onDeleteTrack,
  onUpdateTrack,
  showGhostNotes,
  setShowGhostNotes,
  customVoicebanks,
  onImportProject,
}) => {
  return (
    <div className="bg-slate-900 border-b border-slate-800 flex flex-col shrink-0 select-none">
      {/* Panel Header */}
      <div className="h-10 px-3 bg-slate-950 border-b border-slate-800 flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <Layers className="w-4 h-4 text-cyan-400" />
          <span className="font-semibold text-xs text-slate-200">マルチトラック・ミキサー (Multi-Track)</span>
          <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-cyan-950 text-cyan-400 border border-cyan-800">
            {tracks.length} トラック
          </span>
        </div>

        <div className="flex items-center space-x-2">
          {/* Ghost Notes Toggle */}
          <button
            onClick={() => setShowGhostNotes(!showGhostNotes)}
            className={`text-[11px] px-2.5 py-1 rounded-md transition flex items-center space-x-1.5 border ${
              showGhostNotes
                ? 'bg-cyan-950 text-cyan-300 border-cyan-700/60'
                : 'bg-slate-900 text-slate-400 hover:text-slate-200 border-slate-800'
            }`}
            title="ピアノロール上に別トラックのノート・ピッチを透かし(ゴースト)表示"
          >
            {showGhostNotes ? <Eye className="w-3.5 h-3.5 text-cyan-400" /> : <EyeOff className="w-3.5 h-3.5 text-slate-500" />}
            <span>他トラック透視 (Ghost)</span>
          </button>

          <div className="h-4 w-px bg-slate-800" />

          {/* Import UST/Project into Track */}
          {onImportProject && (
            <button
              onClick={onImportProject}
              className="text-[11px] bg-slate-800 hover:bg-slate-700 text-cyan-300 hover:text-cyan-200 font-medium px-2.5 py-1 rounded-md transition flex items-center space-x-1 border border-slate-700"
              title="UST / VSQX / SVP / MIDI ファイルを選択して読み込み"
            >
              <Upload className="w-3.5 h-3.5 text-cyan-400" />
              <span>UST/MIDI読込</span>
            </button>
          )}

          {/* Add Vocal Track */}
          <button
            onClick={() => onAddTrack('vocal')}
            className="text-[11px] bg-cyan-700 hover:bg-cyan-600 text-white font-medium px-2.5 py-1 rounded-md transition flex items-center space-x-1 border border-cyan-600 shadow-sm"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>+ ボーカル</span>
          </button>

          {/* Add Audio Track */}
          <button
            onClick={() => onAddTrack('wave')}
            className="text-[11px] bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium px-2.5 py-1 rounded-md transition flex items-center space-x-1 border border-slate-700"
          >
            <Music className="w-3.5 h-3.5 text-purple-400" />
            <span>+ 伴奏/WAV</span>
          </button>
        </div>
      </div>

      {/* Track List Strip */}
      <div className="p-2 flex space-x-2 overflow-x-auto">
        {tracks.map((t, idx) => {
          const isSelected = t.id === currentTrackId;
          const trackColor = t.color || TRACK_COLORS[idx % TRACK_COLORS.length];

          return (
            <div
              key={t.id}
              onClick={() => onSelectTrack(t.id)}
              className={`min-w-[210px] p-2.5 rounded-lg border transition cursor-pointer flex flex-col justify-between space-y-2 relative group ${
                isSelected
                  ? 'bg-slate-800/90 border-cyan-500/80 shadow-md shadow-cyan-900/20 ring-1 ring-cyan-500/30'
                  : 'bg-slate-950/70 hover:bg-slate-900 border-slate-800/80 text-slate-400'
              }`}
            >
              {/* Color Stripe Header */}
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: trackColor }} />
                  <input
                    type="text"
                    value={t.name}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => onUpdateTrack(t.id, { name: e.target.value })}
                    className="bg-transparent font-bold text-xs text-slate-200 border-b border-transparent hover:border-slate-700 focus:border-cyan-400 focus:outline-none w-24 truncate"
                  />
                  <span className="text-[9px] font-mono px-1 rounded bg-slate-900 text-slate-400 border border-slate-800">
                    {t.type === 'vocal' ? `${t.notes.length}音` : 'WAV'}
                  </span>
                </div>

                <div className="flex items-center space-x-1">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDuplicateTrack(t.id);
                    }}
                    className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-cyan-300"
                    title="トラック複製"
                  >
                    <Copy className="w-3 h-3" />
                  </button>

                  {tracks.length > 1 && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteTrack(t.id);
                      }}
                      className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-red-400"
                      title="トラック削除"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  )}
                </div>
              </div>

              {/* Voicebank / Type details */}
              {t.type === 'vocal' ? (
                <div className="text-[10px] text-slate-400 flex items-center justify-between">
                  <span>音源:</span>
                  <select
                    value={t.voicebank || ''}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => onUpdateTrack(t.id, { voicebank: e.target.value })}
                    className="bg-slate-900 text-slate-200 text-[10px] border border-slate-700 rounded px-1 py-0.5 max-w-[120px]"
                  >
                    <option value="">(既定音源)</option>
                    {customVoicebanks.map((vb) => (
                      <option key={vb.name} value={vb.name}>
                        {vb.name}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <div className="text-[10px] text-purple-300 flex items-center space-x-1">
                  <Disc className="w-3 h-3 text-purple-400" />
                  <span className="truncate">オーディオ伴奏トラック</span>
                </div>
              )}

              {/* Volume Slider & Mute / Solo Controls */}
              <div className="flex items-center justify-between pt-1 border-t border-slate-800/60" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center space-x-1.5 flex-1 mr-2">
                  <button
                    onClick={() => onUpdateTrack(t.id, { isMuted: !t.isMuted })}
                    className={`px-1.5 py-0.5 text-[9px] font-mono font-bold rounded border transition ${
                      t.isMuted ? 'bg-red-950 text-red-400 border-red-800' : 'bg-slate-900 text-slate-400 border-slate-800 hover:text-slate-200'
                    }`}
                  >
                    M
                  </button>
                  <button
                    onClick={() => onUpdateTrack(t.id, { isSolo: !t.isSolo })}
                    className={`px-1.5 py-0.5 text-[9px] font-mono font-bold rounded border transition ${
                      t.isSolo ? 'bg-amber-950 text-amber-400 border-amber-800' : 'bg-slate-900 text-slate-400 border-slate-800 hover:text-slate-200'
                    }`}
                  >
                    S
                  </button>
                  <input
                    type="range"
                    min="0"
                    max="1.2"
                    step="0.05"
                    value={t.volume}
                    onChange={(e) => onUpdateTrack(t.id, { volume: parseFloat(e.target.value) })}
                    className="w-full accent-cyan-400 h-1.5 bg-slate-900 rounded"
                    title={`音量: ${Math.round(t.volume * 100)}%`}
                  />
                </div>
                <span className="text-[10px] font-mono text-slate-400 font-semibold w-7 text-right">
                  {Math.round(t.volume * 100)}%
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default MultiTrackPanel;
