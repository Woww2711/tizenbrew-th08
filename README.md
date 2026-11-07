# tizenbrew-th08

TizenBrew app module for running [th08-web](https://github.com/N0zoM1z0/th08-web)
(Touhou 8, WebAssembly) on Samsung Tizen TVs.

**Version 0.0.3 is a probe, not the game yet.** It copies your own Touhou 8 data files
(`th08.dat`, `thbgm.dat`) once from a Windows PC to the TV, verifies them (size and SHA-256)
and keeps them in the module's data directory. The probe page at
`<data>/th08/build/launcher.html` then reads them back through the module's service the way
the game will, and checks that saves (th08-web's IndexedDB storage) written by 0.0.2 survived
the module update. This repository contains no game data and never will.

## Use

**PC (Windows, once):** put `th08.dat` and `thbgm.dat` in one folder (default `E:\th08-tv`),
then in PowerShell:

    powershell -ExecutionPolicy Bypass -File pc\serve-th08-data.ps1 -DataDir E:\th08-tv -Address 192.168.1.10

`-Address` is the PC's LAN IP; `-Port` defaults to 8765. The script hashes both files, then
prints the IP, port and an 8-digit token, and serves only `GET /manifest.json`, `/th08.dat`
and `/thbgm.dat` with `?t=<token>`. Windows Firewall must let the TV in: accept the prompt for
Windows PowerShell, or allow TCP 8765 from the TV's IP. Stop it with Ctrl+C once the TV is done.

**TV:** in TizenBrew's module manager add `gh/Woww2711/tizenbrew-th08@0.0.3`, then open
"Touhou 8 (TH08 Web)". The first start downloads the pinned th08-web build (~1.6 MB). Without
game data the page shows a form: enter the PC's IP, port and token with the remote (▲▼ move,
OK types), then Bắt đầu. When both files are copied and verified the probe page opens; from
then on the PC is not needed. 0.0.3 copies the data once: with a data set in place the
service refuses another copy (replacing it comes in a later version). If the page says an
older service is still running, unplug the TV for a minute.

## Develop

Node 24, no dependencies. `service.js` is generated from `src/service/*.js`.

    npm test                     # build service.js and run the tests

`test/pc-server.test.js` runs `pc/serve-th08-data.ps1` under Windows PowerShell from WSL
(skipped elsewhere). Try the whole flow in a desktop browser (each in its own terminal):

    npm run build                                              # once, after changing src/service/
    node tools/dev-server.mjs . 8791                           # serves launcher/ as the download base
    TH08_DATA_DIR=/tmp/th08-data node tools/run-service.mjs    # wait until it prints "ready"
    node tools/fake-pc-server.mjs 8765 12345678                # synthetic data, like the PC script
    curl -X POST -d '{"ip":"127.0.0.1","port":8765,"token":"12345678"}' http://127.0.0.1:8790/setup
    node tools/dev-server.mjs /tmp/th08-data/th08/build 8792

Then open http://localhost:8792/launcher.html. The module page,
http://localhost:8791/app/index.html, shows the setup form while there is no data; once
ready it ends on a PC with "module page not found in DevTools": on the TV the service opens
the file:// launcher through TizenBrew's DevTools (TizenBrew ≥ 2.1 uses `launchUrl()`).
