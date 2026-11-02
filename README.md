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

Try it in a desktop browser (three terminals; stop each with Ctrl+C):

    npm run build                                              # once, after changing src/service/
    node tools/dev-server.mjs . 8791                           # serves spike/ as the asset base
    TH08_DATA_DIR=/tmp/th08-data node tools/run-service.mjs    # wait until it prints "ready"
    node tools/dev-server.mjs /tmp/th08-data/th08/spike 8792

Then open http://localhost:8792/spike.html for the checks (press Enter for audio). The module
page, http://localhost:8791/app/index.html, ends on a PC with "module page not found in
DevTools": on the TV the service opens the file:// spike through TizenBrew's DevTools
(TizenBrew ≥ 2.1 uses the service's `launchUrl()` instead).
