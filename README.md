# tizenbrew-th08

TizenBrew app module for running [th08-web](https://github.com/N0zoM1z0/th08-web)
(Touhou 8, WebAssembly) on Samsung Tizen TVs.

**Version 0.0.2 is a probe, not the game yet.** It installs th08-web's runtime and a test
launcher at the path the real launcher will use, `<data>/th08/build/launcher.html`, and
checks on the TV that saves (th08-web's IndexedDB storage) survive a reload, a power cut
and a module update; it also reports the free space of the data filesystem and whether an
older service still holds the module's port. Version 0.0.1 was the capability spike
(`spike/`, kept for reference; 0.0.2 no longer installs it).

## Use (TV)

In TizenBrew's module manager add `gh/Woww2711/tizenbrew-th08@0.0.2`, then open
"Touhou 8 (TH08 Web)". The first start downloads the pinned th08-web build (~1.6 MB).
The probe page shows what it read from and wrote to save storage; OK runs it again.
If the page says an older service is still running, unplug the TV for a minute.

## Develop

Node 24, no dependencies. `service.js` is generated from `src/service/*.js`.

    npm test                     # build service.js and run the tests

Try it in a desktop browser (three terminals; stop each with Ctrl+C):

    npm run build                                              # once, after changing src/service/
    node tools/dev-server.mjs . 8791                           # serves launcher/ as the download base
    TH08_DATA_DIR=/tmp/th08-data node tools/run-service.mjs    # wait until it prints "ready"
    node tools/dev-server.mjs /tmp/th08-data/th08/build 8792

Then open http://localhost:8792/launcher.html; reload it to see the count go up. The module
page, http://localhost:8791/app/index.html, ends on a PC with "module page not found in
DevTools": on the TV the service opens the file:// launcher through TizenBrew's DevTools
(TizenBrew ≥ 2.1 uses the service's `launchUrl()` instead).
