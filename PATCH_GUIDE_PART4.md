# WASM Abort Issue (Part 4)
I investigated the `Aborted(undefined)` error. Since it's thrown without a message, it comes from a C++ crash or a WASM trap.
A very common cause in Emscripten for Web Workers is `addFunction` failing to allocate a table slot, or throwing an exception during Table Growth (`-s ALLOW_TABLE_GROWTH=1`). If this exception is unhandled, Emscripten aborts the process.
I temporarily disabled `mod.addFunction` in `src/voseCoreWorker.ts` (passing `0` for the callback). This will disable the progress bar updates, but it should allow the WAV rendering to complete successfully if the table growth was the root cause.
