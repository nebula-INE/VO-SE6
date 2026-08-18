const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf8');

const enginePlayCode = `
  const handleEngineRender = async () => {
    if (tracks.length === 0) return;
    
    setIsRenderingWav(true);
    setToast({
      type: 'info',
      title: 'エンジンレンダリング中...',
      desc: 'VO-SE Coreへタイムラインを転送し、WAVを合成しています...'
    });
    
    try {
      const res = await fetch('/api/py/render-wav', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          notes: currentTrack.notes,
          voicebank: currentTrack.voicebank,
          tempo: tempo
        })
      });
      const data = await res.json();
      
      if (data.success && data.audioUrl) {
        setToast({
          type: 'success',
          title: 'レンダリング完了',
          desc: '高品質エンジンのWAV合成が完了しました。再生を開始します。'
        });
        
        const audio = new Audio(data.audioUrl);
        audio.play();
      } else {
        throw new Error(data.error || '合成エラー');
      }
    } catch (e: any) {
      setToast({
        type: 'error',
        title: 'レンダリング失敗',
        desc: e.message
      });
    } finally {
      setIsRenderingWav(false);
    }
  };
`;

code = code.replace(
  'const downloadPresetVoicebank = async', 
  enginePlayCode + '\n  const downloadPresetVoicebank = async'
);

const btnHtml = `
                  <button
                    onClick={() => {
                      setIsPlaying(false);
                      setCurrentTick(0);
                    }}
                    className="w-10 h-8 flex items-center justify-center rounded-r-md bg-slate-800 hover:bg-slate-700 text-slate-300 transition"
                  >
                    <Square className="w-4 h-4 fill-current" />
                  </button>
                  
                  <div className="w-px h-6 bg-slate-700 mx-1"></div>
                  
                  <button
                    onClick={handleEngineRender}
                    disabled={isRenderingWav}
                    className={\`h-8 px-3 ml-2 flex items-center justify-center rounded-md font-bold text-xs transition \${
                      isRenderingWav 
                      ? 'bg-purple-900/50 text-purple-400 cursor-wait' 
                      : 'bg-purple-600 hover:bg-purple-500 text-white shadow-lg shadow-purple-500/20'
                    }\`}
                  >
                    {isRenderingWav ? (
                      <><Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> 合成中...</>
                    ) : (
                      <><Zap className="w-4 h-4 mr-1.5" /> 高音質レンダリング</>
                    )}
                  </button>
`;

code = code.replace(
  /<button\s+onClick=\{\(\) => \{\s+setIsPlaying\(false\);\s+setCurrentTick\(0\);\s+\}\}\s+className="w-10 h-8 flex items-center justify-center rounded-r-md bg-slate-800 hover:bg-slate-700 text-slate-300 transition"\s+>\s+<Square className="w-4 h-4 fill-current" \/>\s+<\/button>/g,
  btnHtml
);

fs.writeFileSync('src/App.tsx', code);
console.log("Render button added.");
