import React, { useState, useMemo } from 'react';
import { Type, Check, X, Sparkles, HelpCircle, ArrowRight } from 'lucide-react';

interface BatchLyricModalProps {
  isOpen: boolean;
  onClose: () => void;
  notes: Array<{ id: string; lyric: string; tick: number; noteNum: number }>;
  onApplyLyrics: (newLyrics: string[]) => void;
}

// Convert various Japanese inputs (Romaji / Hiragana / Katakana / English) or segment string into individual lyric tokens
export const parseLyricTokens = (rawText: string, delimiterMode: 'auto' | 'char' | 'space' | 'line'): string[] => {
  if (!rawText.trim()) return [];

  if (delimiterMode === 'space') {
    return rawText.trim().split(/\s+/).filter(Boolean);
  }

  if (delimiterMode === 'line') {
    return rawText.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  }

  if (delimiterMode === 'char') {
    // Split by character, but preserve digraphs like "きゃ", "しゅ", "ちょ", "てぃ", "ふぁ", "っ", etc. if appropriate
    return segmentJapaneseCharacters(rawText);
  }

  // Auto mode: If contains spaces or newlines, split by whitespace. Otherwise, segment by kana/morae.
  if (/\s+/.test(rawText.trim())) {
    return rawText.trim().split(/\s+/).filter(Boolean);
  }

  return segmentJapaneseCharacters(rawText);
};

// Segment Japanese text respecting small kana like ゃ, ゅ, ょ, ぁ, ぃ, ぅ, ぇ, ぉ, っ, ゎ
export const segmentJapaneseCharacters = (text: string): string[] => {
  const cleaned = text.replace(/[\r\n\t]/g, '').trim();
  const smallKanaRegex = /^[ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮー]/;
  const result: string[] = [];

  let i = 0;
  while (i < cleaned.length) {
    let char = cleaned[i];
    if (char === ' ') {
      i++;
      continue;
    }

    // Check if next character is small kana or prolonged sound mark (結合)
    if (i + 1 < cleaned.length && smallKanaRegex.test(cleaned[i + 1])) {
      char += cleaned[i + 1];
      i += 2;
    } else {
      i += 1;
    }

    result.push(char);
  }

  return result;
};

export const BatchLyricModal: React.FC<BatchLyricModalProps> = ({
  isOpen,
  onClose,
  notes,
  onApplyLyrics,
}) => {
  const [inputText, setInputText] = useState('');
  const [delimiterMode, setDelimiterMode] = useState<'auto' | 'char' | 'space' | 'line'>('auto');
  const [fillMode, setFillMode] = useState<'all' | 'from_start' | 'loop'>('all');

  // Sorted notes by timeline tick
  const sortedNotes = useMemo(() => {
    return [...notes].sort((a, b) => a.tick - b.tick);
  }, [notes]);

  const parsedTokens = useMemo(() => {
    return parseLyricTokens(inputText, delimiterMode);
  }, [inputText, delimiterMode]);

  if (!isOpen) return null;

  const handleApply = () => {
    if (parsedTokens.length === 0) return;

    let appliedLyrics: string[] = [];

    if (fillMode === 'loop') {
      // Loop tokens to fill all notes
      appliedLyrics = sortedNotes.map((_, idx) => parsedTokens[idx % parsedTokens.length]);
    } else {
      // Pad or truncate to notes length
      appliedLyrics = sortedNotes.map((note, idx) => {
        if (idx < parsedTokens.length) {
          return parsedTokens[idx];
        }
        return note.lyric; // Keep existing if tokens run out
      });
    }

    onApplyLyrics(appliedLyrics);
    onClose();
  };

  const samplePresets = [
    { label: 'ドレミファソラシド', text: 'ど れ み ふぁ そ ら し ど' },
    { label: 'かえるのうた', text: 'か え る の う た が き こ え て く る よ' },
    { label: 'キラキラ星', text: 'き ら き ら ひ か る お そ ら の ほ し よ' },
    { label: 'あー (全音符あ)', text: 'あ' },
    { label: 'ららら (ループ用)', text: 'ら ら ら' },
  ];

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-xl overflow-hidden flex flex-col max-h-[90vh] animate-in fade-in zoom-in duration-150">
        {/* Header */}
        <div className="px-5 py-3.5 bg-slate-950 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <div className="p-1.5 bg-cyan-950/80 border border-cyan-500/40 rounded-lg text-cyan-400">
              <Type className="w-4 h-4" />
            </div>
            <div>
              <h2 className="font-bold text-sm text-slate-100 flex items-center gap-1.5">
                歌詞一括入力 (Batch Lyric Input)
              </h2>
              <p className="text-[11px] text-slate-400">
                トラック内の全 {sortedNotes.length} 個の音符に歌詞を順番に割り当てます
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-200 p-1 rounded-lg hover:bg-slate-800 transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-4 overflow-y-auto flex-1 text-xs">
          {/* Preset Buttons */}
          <div>
            <span className="text-slate-400 text-[11px] font-medium block mb-1.5">クイック入力プリセット:</span>
            <div className="flex flex-wrap gap-1.5">
              {samplePresets.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => setInputText(preset.text)}
                  className="px-2.5 py-1 bg-slate-800/80 hover:bg-slate-700 text-slate-300 hover:text-cyan-300 border border-slate-700 rounded text-[11px] transition"
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          {/* Input Area */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-slate-300 font-bold flex items-center gap-1">
                <span>歌詞テキストを入力:</span>
                <span className="text-slate-500 font-normal">(ひらがな・空白区切り・改行など)</span>
              </label>
              <span className="text-cyan-400 font-mono text-[11px]">
                {parsedTokens.length} 文字 / {sortedNotes.length} ノート
              </span>
            </div>
            <textarea
              rows={4}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder="例: さ く ら さ く ら や よ い の そ ら は (スペース区切りまたは連続入力)"
              className="w-full bg-slate-950 border border-slate-700 focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 rounded-lg p-3 text-slate-100 placeholder-slate-600 font-mono text-sm leading-relaxed resize-none"
              autoFocus
            />
          </div>

          {/* Options Grid */}
          <div className="grid grid-cols-2 gap-3 bg-slate-950/60 p-3 rounded-lg border border-slate-800">
            <div>
              <label className="text-slate-400 font-medium block mb-1">区切り方法:</label>
              <select
                value={delimiterMode}
                onChange={(e) => setDelimiterMode(e.target.value as any)}
                className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-slate-200"
              >
                <option value="auto">自動判別 (スペース区切り / 1文字ごと)</option>
                <option value="space">空白・スペース区切り (「か え る」)</option>
                <option value="char">1文字・モーラごと (「かえる」→ か, え, る)</option>
                <option value="line">行ごと (1行1音符)</option>
              </select>
            </div>

            <div>
              <label className="text-slate-400 font-medium block mb-1">歌詞が足りない場合:</label>
              <select
                value={fillMode}
                onChange={(e) => setFillMode(e.target.value as any)}
                className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-slate-200"
              >
                <option value="all">足りない分は元の歌詞を維持</option>
                <option value="loop">歌詞を繰り返して全音符に適用 (ループ)</option>
              </select>
            </div>
          </div>

          {/* Live Preview of Note Assignment */}
          <div>
            <label className="text-slate-400 font-medium block mb-1.5">適用プレビュー (先頭12音符):</label>
            <div className="bg-slate-950 border border-slate-800 rounded-lg p-2.5 max-h-36 overflow-x-auto">
              {sortedNotes.length === 0 ? (
                <div className="text-slate-600 text-center py-4">トラックにノートがありません</div>
              ) : (
                <div className="flex gap-1.5 min-w-max">
                  {sortedNotes.slice(0, 16).map((note, idx) => {
                    const assignedLyric =
                      fillMode === 'loop' && parsedTokens.length > 0
                        ? parsedTokens[idx % parsedTokens.length]
                        : idx < parsedTokens.length
                        ? parsedTokens[idx]
                        : note.lyric;
                    const isChanged = assignedLyric !== note.lyric;

                    return (
                      <div
                        key={note.id}
                        className={`flex flex-col items-center justify-between p-1.5 rounded border text-center w-14 shrink-0 transition ${
                          isChanged
                            ? 'bg-cyan-950/60 border-cyan-500/60 text-cyan-200'
                            : 'bg-slate-900 border-slate-800 text-slate-400'
                        }`}
                      >
                        <span className="text-[9px] text-slate-500 font-mono">#{idx + 1}</span>
                        <span className="text-sm font-bold my-0.5 truncate max-w-full">
                          {assignedLyric || 'あ'}
                        </span>
                        <span className="text-[9px] opacity-60 font-mono truncate">
                          {note.lyric}
                        </span>
                      </div>
                    );
                  })}
                  {sortedNotes.length > 16 && (
                    <div className="flex items-center justify-center px-2 text-slate-500 font-mono text-[10px]">
                      +{sortedNotes.length - 16} more
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 bg-slate-950 border-t border-slate-800 flex items-center justify-between">
          <span className="text-[11px] text-slate-500">
            {parsedTokens.length > 0
              ? `${Math.min(parsedTokens.length, sortedNotes.length)} 音符の歌詞を更新します`
              : '歌詞を入力してください'}
          </span>
          <div className="flex items-center space-x-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-medium transition"
            >
              キャンセル
            </button>
            <button
              type="button"
              onClick={handleApply}
              disabled={parsedTokens.length === 0 || sortedNotes.length === 0}
              className="px-4 py-1.5 bg-gradient-to-r from-cyan-600 to-cyan-500 hover:from-cyan-500 hover:to-cyan-400 text-slate-950 font-bold rounded-lg text-xs flex items-center space-x-1.5 shadow-lg shadow-cyan-950/50 disabled:opacity-40 disabled:pointer-events-none transition"
            >
              <Check className="w-3.5 h-3.5" />
              <span>一括適用する</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default BatchLyricModal;
