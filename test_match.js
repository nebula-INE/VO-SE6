const aliasMap = new Map();
aliasMap.set('a ざ', { filename: 'vocal_25.wav' });
aliasMap.set('ざ', { filename: 'vocal_25.wav' });
aliasMap.set('あ', { filename: 'vocal_00.wav' });
aliasMap.set('ー', { filename: 'vocal_00.wav' }); // wait, oto.ini doesn't have ー

function getMidiFromPitchTag() { return 60; }

function matchPrefixOrExact(prefixStr, noteNum) {
    if (!prefixStr) return null;
    const prefNorm = prefixStr.normalize('NFC');
    const prefLower = prefNorm.toLowerCase();

    // 1. Exact match
    if (aliasMap.has(prefNorm)) return aliasMap.get(prefNorm);

    // 2. Pitch-suffixed search with proximity to requested noteNum
    const midi = (noteNum !== null && noteNum !== undefined) ? Math.round(Number(noteNum)) : 60;
    let bestEntry = null;
    let minDiff = 999;

    for (const [key, entry] of aliasMap.entries()) {
      const kNorm = key.normalize('NFC');
      const kLower = kNorm.toLowerCase();
      
      let isMatch = false;
      if (kLower === prefLower) {
        isMatch = true;
      } else if (kLower.startsWith(prefLower)) {
        const remainder = kLower.slice(prefLower.length).trim();
        if (/^(_|\s)?([a-g][#b]?[0-9]|[↑↓強弱sp]+)$/i.test(remainder)) {
          isMatch = true;
        }
      }

      if (isMatch) {
        const entryMidi = 60;
        const diff = Math.abs(midi - entryMidi);
        if (diff < minDiff) {
          minDiff = diff;
          bestEntry = { key, entry, diff };
        }
      }
    }
    return bestEntry ? bestEntry.entry : null;
}

console.log("Testing 'a':", matchPrefixOrExact('a'));
console.log("Testing 'ー':", matchPrefixOrExact('ー'));
console.log("Testing 'ざ':", matchPrefixOrExact('ざ'));

// Wait, what if `aliasMap` contains `a ざ` and user searches `a `?
