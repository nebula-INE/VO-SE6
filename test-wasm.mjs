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
    const ptr = mod._malloc(36 * 1);
    mod.ccall('execute_render', null, ['number', 'number', 'string', 'number'], [ptr, 0, '/out.wav', 0]);
    console.log('execute_render returned');
  } catch(e) {
    console.log('error', e);
  }
}).catch(e => console.log('load error', e));
