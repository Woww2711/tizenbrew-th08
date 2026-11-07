# tizenbrew-th08

TizenBrew app module for running [th08-web](https://github.com/N0zoM1z0/th08-web)
(Touhou 8, WebAssembly) on Samsung Tizen TVs, with your own Touhou 8 data files.

Version 0.0.4 runs the game. It copies your `th08.dat` and `thbgm.dat` once from a Windows PC
to the TV, verifies them (size and SHA-256) and keeps them in the module's data directory. The
launcher at `<data>/th08/build/launcher.html` then starts th08-web v0.1.0 with them: the game
data is read into memory, the music is read piece by piece through the module's service.
Scores, replays and settings are kept in the browser storage of the TV (IndexedDB). Play with
a gamepad (standard mapping), a keyboard, or the remote for menus. This repository contains
no game data and never will.

## Use

**PC (Windows, once):** put `th08.dat` and `thbgm.dat` in one folder (default `E:\th08-tv`),
then in PowerShell:

    powershell -ExecutionPolicy Bypass -File pc\serve-th08-data.ps1 -DataDir E:\th08-tv -Address 192.168.1.10

`-Address` is the PC's LAN IP; `-Port` defaults to 8765. The script hashes both files, then
prints the IP, port and an 8-digit token, and serves only `GET /manifest.json`, `/th08.dat`
and `/thbgm.dat` with `?t=<token>`. Windows Firewall must let the TV in (see below). Stop it
with Ctrl+C once the TV is done.

**TV:** in TizenBrew's module manager add `gh/Woww2711/tizenbrew-th08@0.0.4`, then open
"Touhou 8 (TH08 Web)". The first start downloads the pinned th08-web build (~1.6 MB). Without
game data the page shows a form: enter the PC's IP, port and token with the remote (▲▼ move,
OK types), then Bắt đầu. When both files are copied the launcher opens; from then on the PC is
not needed. If the page says an older service is still running, unplug the TV for a minute.

**Controls:** "Bấm OK (hoặc A trên tay cầm) để bắt đầu" — that press only starts the game; a
held OK or A reaches the game only after it is released. Sound needs an OK on the remote (or
Enter): browsers do not count a gamepad button as a user action, so after starting with A the
page asks "Âm thanh chưa bật — bấm OK trên remote" if the sound is still off.

| Game | Gamepad (standard) | Keyboard | Remote |
|---|---|---|---|
| Move | D-pad, left stick | arrows | arrows |
| Confirm / shoot (Z) | A | Z or Enter | OK |
| Cancel / bomb (X) | B | X | — |
| Focus (Shift) | LB or RB | Shift | — |
| Pause (Esc) | Start | Esc | Back |
| Launcher menu | hold Select 2 s | F2 | — |

Keys from all sources are combined (holding Shift and LB, then letting go of one, keeps focus).
After the page loses focus or is hidden, or the pad is unplugged, the pad is ignored until all
its buttons are up and the stick is centred. The launcher menu shows the frame rate, late
audio callbacks and music read times on screen, and has "Thử dừng service" (stops the
service on purpose, to check that a dead service shows a warning and the game does not hang).

The game saves (score, replays, settings) a second after it has written them; "Đã lưu" shows
when the TV's storage has them. A yellow bar means the music cannot be read from the service
(the game keeps running; it clears when reads work again); a red bar means saving stopped for
this session or the game itself failed. To leave, use the TV's Home key. "Quit" on the title
screen ends th08-web's loop: after 15 s without a new frame the page says so; OK or A starts
the game again.

## If the TV cannot reach the PC (firewall)

The copy fails with "Không kết nối được máy tính …" and the PowerShell window logs nothing.
On a network marked **Public**, Windows may hold **Block** rules for `powershell.exe` (created
when a firewall prompt for Windows PowerShell was cancelled). A Block rule wins over every
Allow rule, so adding an Allow rule for port 8765 does not help. In an **administrator**
PowerShell, select exactly the rules that block the server — enabled, inbound, Block, on the
Public profile, for `powershell.exe` — and keep their names:

    $block = Get-NetFirewallRule -DisplayName "Windows PowerShell" | Where-Object {
      $_.Action -eq 'Block' -and $_.Direction -eq 'Inbound' -and $_.Enabled -eq 'True' -and
      ($_.Profile -match 'Public|Any') -and
      (($_ | Get-NetFirewallApplicationFilter).Program -like '*\WindowsPowerShell\v1.0\powershell.exe') }
    $block | Format-Table Name, DisplayName, Enabled, Profile, Direction, Action
    $block.Name | Set-Content "$env:TEMP\th08-firewall-disabled.txt"

Turn off **only those**, for the copy:

    $block | Disable-NetFirewallRule

Once the TV has the files, turn back on exactly the rules whose names were saved (nothing
else: rules that were already off, or that block other programs or profiles, are untouched):

    Get-Content "$env:TEMP\th08-firewall-disabled.txt" | ForEach-Object { Enable-NetFirewallRule -Name $_ }
    Get-Content "$env:TEMP\th08-firewall-disabled.txt" | ForEach-Object { Get-NetFirewallRule -Name $_ } |
      Format-Table Name, Enabled, Profile, Action
    Remove-Item "$env:TEMP\th08-firewall-disabled.txt"

(`Enabled` must be `True` again for every listed rule.) Without Block rules, accepting the
Windows prompt for Windows PowerShell, or an Allow rule for TCP 8765 from the TV's IP, is enough.

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

With synthetic data the launcher stops at the game's start. To play locally, serve your own
files instead (`node tools/fake-pc-server.mjs 8765 12345678 --dir /mnt/e/th08-tv`, read-only;
the copy lands in `TH08_DATA_DIR`, delete it afterwards) and open the `launcherUrl` from
`/status` (a `file://` URL, like on the TV) in Chromium with
`--allow-file-access-from-files --enable-features=SharedArrayBuffer --remote-debugging-port=9333`.
`node tools/cdp.mjs 9333 key Enter` presses OK, `… pad press 0` presses A on a fake gamepad
(it proves the launcher's mapping, not a real pad's), `… eval 'TH08Launcher.stats'` shows what
the launcher measured, `… shot out.png` takes a screenshot.
