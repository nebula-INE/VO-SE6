import fs from 'fs';
import path from 'path';
import createVoseCoreModule from './public/wasm/vose_core.js';
createVoseCoreModule({
  locateFile: (p) => 'file://' + path.resolve('./public/wasm/' + p)
}).then(mod => {
  console.log("WASM Loaded", mod._get_engine_version());
}).catch(e => {
  console.error("Error", e);
});
