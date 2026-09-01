import createVoseCoreModule from './public/wasm/vose_core.js';
import fs from 'fs';

createVoseCoreModule({
  instantiateWasm: function(imports, successCallback) {
    const wasmBinary = fs.readFileSync('./public/wasm/vose_core.wasm');
    WebAssembly.instantiate(wasmBinary, imports).then((output) => {
      successCallback(output.instance);
    });
    return {};
  }
}).then(mod => {
  console.log('Module loaded');
  try {
    const NOTE_EVENT_SIZE = 44;
    const ptr = mod._malloc(NOTE_EVENT_SIZE * 1);
    const wavPath = mod._malloc(10);
    mod.stringToUTF8("test", wavPath, 10);
    const pitchCurve = mod._malloc(8 * 10);
    for(let i=0; i<10; i++) mod.setValue(pitchCurve + i*8, 440.0, 'double');
    
    mod.setValue(ptr + 0, wavPath, 'i32'); // OFF_WAV_PATH
    mod.setValue(ptr + 4, pitchCurve, 'i32'); // OFF_PITCH_CURVE
    mod.setValue(ptr + 8, 10, 'i32'); // OFF_PITCH_LENGTH
    for(let i=12; i<44; i+=4) mod.setValue(ptr + i, 0, 'i32'); // zero out everything else!
    
    const samples = 44100;
    const pcm = mod._malloc(samples * 2);
    for(let i=0; i<samples*2; i++) mod.setValue(pcm + i, 0, 'i8');
    mod.ccall('load_embedded_resource', null, ['string', 'number', 'number'], ['test', pcm, samples]);
    
    mod.ccall('execute_render', null, ['number', 'number', 'string', 'number'], [ptr, 1, '/out.wav', 0]);
    console.log('execute_render returned');
  } catch(e) {
    console.log('error', e);
  }
}).catch(e => console.log('load error', e));
