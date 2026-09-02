import fs from 'fs';
import path from 'path';

async function run() {
    const modPromise = await import('./public/wasm/vose_core.js');
    const createVoseCoreModule = modPromise.default;
    const mod = await createVoseCoreModule({
        locateFile: (p) => {
            if (p.endsWith('.wasm')) return path.resolve('./public/wasm/vose_core.wasm');
            return p;
        }
    });

    console.log("WASM Loaded!");
}
run().catch(console.error);
