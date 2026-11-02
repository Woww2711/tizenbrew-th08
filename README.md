# tizenbrew-th08

TizenBrew app module for running [th08-web](https://github.com/N0zoM1z0/th08-web)
(Touhou 8, WebAssembly) on Samsung Tizen TVs.

**Version 0.0.1 is the milestone-0 capability spike**: it checks whether the TV can run
th08-web from a `file://` page (cross-origin isolation, workers + Atomics, WebGL 2,
range reads from the module service, audio). It does not run the game yet.

## Use (TV)

In TizenBrew's module manager add `gh/Woww2711/tizenbrew-th08@0.0.1`, then open
"Touhou 8 (TH08 Web)". The first start downloads the pinned th08-web build (~1.6 MB).
The results table appears; press OK on the remote for the audio check.

## Develop

Node 24, no dependencies. `service.js` is generated from `src/service/*.js`.

    npm test                     # build service.js and run the tests

Try the spike in a desktop browser (three terminals):

    node tools/dev-server.mjs . 8791
    TH08_DATA_DIR=/tmp/th08-data node tools/run-service.mjs
    node tools/dev-server.mjs /tmp/th08-data/th08/spike 8792   # then open http://localhost:8792/spike.html
