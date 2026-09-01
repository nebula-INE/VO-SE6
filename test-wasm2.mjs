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
    const NOTE_EVENT_SIZE = 36;
    const ptr = mod._malloc(NOTE_EVENT_SIZE * 1);
    const wavPath = mod._malloc(10);
    mod.stringToUTF8("test", wavPath, 10);
    const pitchCurve = mod._malloc(8 * 100);
    mod.setValue(ptr + 0, wavPath, 'i32'); // OFF_WAV_PATH
    mod.setValue(ptr + 4, pitchCurve, 'i32'); // OFF_PITCH_CURVE
    mod.setValue(ptr + 8, 100, 'i32'); // OFF_PITCH_LENGTH
    for(let i=12; i<36; i+=4) mod.setValue(ptr + i, 0, 'i32');
    
    // Also load a dummy sample so it doesn't fail to find "test"
    const pcm = mod._malloc(100 * 2);
    mod.ccall('load_embedded_resource', null, ['string', 'number', 'number'], ['test', pcm, 100]);
    
    mod.ccall('execute_render', null, ['number', 'number', 'string', 'number'], [ptr, 1, '/out.wav', 0]);
    console.log('execute_render returned');
  } catch(e) {
    console.log('error', e);
  }
}).catch(e => console.log('load error', e));
