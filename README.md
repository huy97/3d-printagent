# 3D PrintAgent

An agent that runs on your local machine to manage several 3D printers at once: watch temperatures and progress, put files into a library, slice STL/OBJ models, print now or queue, control printers remotely, view cameras. Other systems call in over REST, WebSocket or MCP; people manage it through the web UI; expose it to the Internet with Cloudflare Tunnel or ngrok.

| Interface | Address | Used for |
| --- | --- | --- |
| Web UI | `http://<host>:7790` | Adding printers, file library, queue, controls, cameras, tunnel, API keys |
| REST API | `http://<host>:7790/api` | Web apps, backends, Home Assistant, scripts |
| WebSocket | `ws://<host>:7790/ws` | Live temperatures, progress and job status |
| MCP | `http://<host>:7790/mcp` (HTTP) or stdio | Claude Code, Claude Desktop, Cursor and other AI agents |

## Supported printers

| Driver | Printers | Formats | Control |
| --- | --- | --- | --- |
| `octoprint` | Any printer running through OctoPrint (OctoPi, Raspberry Pi) | G-code | Full: temperatures, movement, fans, speed, G-code, load/unload filament, camera |
| `moonraker` | Klipper via Moonraker (Mainsail, Fluidd, rooted Creality K1, Voron, ...) | G-code | Full |
| `prusalink` | Prusa MK4, MK3.9, XL, MINI, Core One | G-code, BGCode | Upload, print, pause, resume, cancel; camera when `cameraUrl` is set |
| `bambu` | Bambu Lab X1, X2D, P1, P2S, A1, A2L, H2 (H2D, H2D Pro, H2S, H2C) over LAN | 3MF, G-code | Full, including AMS (tray view, load/unload filament), light, HMS, camera |
| `virtual` | Simulated printer | G-code, BGCode, 3MF | Full, for testing an integration before real hardware is available |

Marlin printers wired directly over USB/serial are not supported: put OctoPrint or Klipper in front of them. Bambu Cloud is never used; every Bambu connection goes over the LAN (MQTT on port 8883, FTPS on port 990).

## Requirements

- Node.js >= 22.13 (uses the SQLite built into Node through `node:sqlite`, no native module needed)
- Optional: `cloudflared` or `ngrok` for a public tunnel
- Optional: `ffmpeg` to grab camera stills from Bambu X1, X2D, P2S and the H2 series (RTSPS). P1, A1 and A2L do not need it.

## Install and run

From source:

```bash
yarn install
yarn build        # build the web UI into web/
yarn start        # or: node bin/3d-printagent.js start --open
```

Once the package is published to npm:

```bash
npx -y @hyydev/3d-printagent start --open
```

On the first run the agent creates `~/.3d-printagent`, generates an API key (`p3d_...`) and listens on port 7790. Open `http://127.0.0.1:7790`: a browser on the machine running the agent gets in without a key.

With no real printer yet, use the simulated printer button on the Printers tab to try the whole flow: upload, queue, controls and camera.

### CLI commands

```
3d-printagent start [--port 7790] [--host 0.0.0.0] [--open]
3d-printagent service install|uninstall|status   # run in the background with the OS
3d-printagent mcp [--url URL] [--key KEY] [--standalone]
3d-printagent printers                           # list printers and their status
3d-printagent drivers                            # drivers and their connection fields
3d-printagent discover [--timeout 12000]         # scan the LAN for printers
3d-printagent detect <ip> [--port 80]            # guess the printer type from an IP
3d-printagent config                             # print the current config
3d-printagent key                                # print the API key
3d-printagent tunnel [check|cloudflare|ngrok]
3d-printagent version
```

Environment variables: `PRINTAGENT3D_DATA_DIR` (data directory), `PRINTAGENT3D_LANG` (`en` or `vi` for logs and the CLI), `PORT`, `PRINTAGENT3D_LOG_LEVEL`.

## Adding a printer

In the web UI: Printers tab, Add printer button. You can type an IP and run detection, or scan the LAN, then test the connection before saving. Through the API:

```bash
curl -X POST http://127.0.0.1:7790/api/printers \
  -H "x-api-key: p3d_xxx" -H "content-type: application/json" \
  -d '{"name":"Voron 2.4","driver":"moonraker","connection":{"host":"192.168.1.40"}}'
```

What each printer type needs:

- **OctoPrint**: `host`, `apiKey` (Settings → Application Keys, or the API section in OctoPrint). The agent picks up the camera snapshot URL from OctoPrint's webcam settings; only set `cameraUrl` to override it.
- **Klipper/Moonraker**: `host`. Leave the port empty to go through the Mainsail/Fluidd nginx (port 80), or use 7125 to talk to Moonraker directly. `apiKey` is required if the agent's IP is not in Moonraker's `trusted_clients`. Cameras come from Moonraker's webcam list.
- **PrusaLink**: `host`, `username` (`maker` by default) and `password`, both shown under Settings → Network → PrusaLink on the printer, or `apiKey` on older firmware.
- **Bambu Lab**: `host`, `serial` (in the printer info on the screen or in Bambu Studio), `accessCode` (8 characters, in the network/LAN settings on the printer screen). Turn on LAN Only mode; on firmware with Authorization Control, also enable Developer Mode so third-party software may control the printer. `model` helps pick the right way to fetch the camera.

Every printer has two important options:

- **Bed clear** (`bedClear`): when a print starts, the agent marks the bed as not clear. The next print-now command is refused until someone confirms the previous print has been removed. This keeps the printer from printing on top of an object still sitting on the bed.
- **Auto-start queue** (`autoStartQueue`): when the printer is idle and the bed has been confirmed clear, the agent starts the next job in the queue by itself.

## Web UI

- **Overview**: printers online, queue, library, tunnel, a card per printer with progress and temperatures, recent print jobs.
- **Printers**: live status, a 30-minute temperature chart (with a data table), self-refreshing camera, temperature controls (with PLA/PETG/ABS/TPU presets), axis movement, fans, print speed, light, load and unload filament, a G-code console with a built-in command library (filtered by printer type, each command described), Bambu AMS and HMS error codes, files currently on the printer.
- **File library**: drag and drop several files, add from a URL, read slicer metadata (print time, filament, layer height, nozzle, 3MF plate count) and the preview image embedded in the file. Also accepts un-sliced STL, OBJ and 3MF models to slice on the agent itself.
- **Print jobs**: filter by status and printer, cancel, run a waiting job, reprint. Waiting jobs can be reordered and reprioritised and show their start and estimated finish time; finished jobs show grams of filament used, waste and cost.
- **Filament and statistics**: spools assigned to a printer and tray, with weight deducted automatically after each print; success rate, filament used, filament wasted (support, brim/skirt, colour purge, failed prints), filament, power and wear costs by day, printer, filament type and file; maintenance tasks that are due.
- **Tunnel**, **API & MCP**, **Settings**: see the sections below.

The UI is in English by default; Vietnamese is available through the locale setting. It works well on phones.

## Slicing

The agent calls the CLI of **OrcaSlicer** or **BambuStudio** installed on the machine running the agent: no account login, no GUI.

- It looks for OrcaSlicer first, then BambuStudio, in the usual locations on macOS, Linux and Windows. To point at one explicitly, set `slicer.binPath` in Settings (editable only from the machine running the agent).
- On headless Linux the agent re-runs the slicer through `xvfb-run` when it asks for a display.
- Printer, quality and filament profiles are read straight from the slicer's installation directory, including non-Bambu vendors (Creality, Prusa, Voron, Elegoo, Anycubic, Qidi, ...). The agent merges the whole `inherits` chain plus every file listed in `include` before calling the CLI, because the CLI does not follow them itself and falls back to default settings. Newer Bambu printers keep their start, end and layer-change G-code in separate `include` files; skip this merge and the printer runs the slicer's default start G-code: wrong first-layer temperature, no bed levelling, no nozzle wipe. Presets saved inside the slicer also resolve back to the correct stock profile for that exact printer, because a dozen vendors name their stock profiles identically (`fdm_filament_pet`).
- Printers that accept 3MF keep the `.gcode.3mf` as is; for printers that only accept G-code the agent extracts `Metadata/plate_1.gcode` into a `.gcode` file.
- The result lands straight in the library with a plate image, estimated time and filament weight, ready to print.
- Besides the profile, the slicing dialog also exposes layer height and first layer height, seam position, ironing, wall loops, top/bottom shell layers, infill density and pattern, outer/inner wall and infill speed (mm/s), support and support type, nozzle and bed temperature, brim, vase mode, scale, rotation and the number of copies on the plate.
- Settings not in the form go into the "Other settings" box as `key = value` (`extra` in the API), using the slicer's own setting names, for example `top_surface_pattern = monotonic`.
- The agent measures each model as it arrives: bounding box, solid volume, triangle count and the share of downward-facing area steeper than 30 degrees (faces resting on the bed excluded). It reads binary STL, ASCII STL, OBJ and un-sliced 3MF (honouring each build item's transform).
- The "AI suggest" button in the slicing dialog sends those measurements, the printer details, the selected profile and the user's description of what the print is for to Anthropic, and returns a set of parameters with reasoning; you review them before pressing Apply. It needs a credential entered in Settings on the machine running the agent, sent either as an API key (`x-api-key`) or an auth token (`Authorization: Bearer`) depending on the provider; the value stays on that machine and is only sent when you press the button.

## Queue, filament and maintenance

- **Shared queue**: when printing, choose "First compatible printer that is free" so the job runs on the first compatible idle printer with the right filament and a clear bed. Turn on "Urgent" to jump ahead of normal jobs.
- **Batch printing (farm)**: turn on "Print on several printers at once" in the print dialog, tick the printers and press Print: every selected printer starts the same file right away, one copy each, with no queueing. Printers that are busy or whose bed has not been confirmed clear are skipped (there is a bed-clear confirmation switch for the whole group). Each job shows "Batch 2/5", and the whole batch can be cancelled at once.
- **Estimated time** is calibrated per printer from history: the agent compares real print times with the slicer's estimate and applies that factor to later jobs.
- **Filament accounting**: the agent parses the G-code to split filament into product and waste (support, brim/skirt/raft, colour-change purge); failed or cancelled prints are counted up to the layer where they stopped.
- **Pre-print check**: the print dialog shows grams needed, waste, finish time, cost and a warning when the loaded spool is short or of the wrong type.
- **Costs**: set the electricity price, power draw and default filament price in Settings; per-printer power draw and hourly wear go in the printer edit dialog.
- **Maintenance** by print hours (lubricate rails, clean the nozzle, replace PTFE, ...), with default tasks per printer and room for your own; when a task is due it shows on the printer page, on Overview, and goes out over Telegram.
- **Auto-orient** models to the angle that needs the least support, and **pack a plate** with several files (several copies each) according to the printer's build size.
- **Deduplication**: an uploaded file with identical content (SHA-256) reuses the existing file; re-slicing the same model with the same settings comes from cache.

## Alerts and error diagnosis

- Bambu printers report HMS codes such as `HMS_0300_1A00_0002_0001`. The agent downloads the vendor's official code catalog to `~/.3d-printagent/hms-catalog.json` (in the configured language, refreshed every 30 days) and shows the description directly, with a severity: fatal, serious, warning, info. If the download fails, the raw code is still shown and the printer is unaffected.
- The "Printer alerts" card has a Diagnose button: the agent sends the printer state, temperatures, the running print, the translated HMS codes and the outcome of a few recent jobs to the model, and gets back a summary, a list of likely causes and the steps to fix it. It uses the same credential as AI suggest.
- The system prompts of the four AI features (slicing suggestions, printer diagnosis, camera image review, pre-print file review) live in `src/core/prompts/*.md` and can be edited directly in the "AI prompts" card on the Settings tab. Edited versions are saved as `.md` files in `~/.3d-printagent/prompts/`; the agent re-reads the file on every request, so changes take effect immediately. Press "Reset to default" or delete the file to go back to the original. Editable only from the machine running the agent.

## Authentication

- Every request needs the header `x-api-key: p3d_xxx` or `Authorization: Bearer p3d_xxx`. WebSockets and `<img>` tags use the `?apiKey=` query parameter.
- Requests from the machine running the agent (a browser on `http://127.0.0.1:7790`) are exempt from the key. The agent only exempts a request when the address and the `Host` and `Origin` headers are all loopback and no proxy headers are present, so requests through a tunnel or started by another website do not slip through.
- Creating, fully viewing and deleting API keys, and editing sensitive settings (safety limits, file sources, `auth`, `server`), are only possible locally.
- Ten wrong keys within a minute blocks that address for 5 minutes.

## Safety limits

Applied to every command from the web UI, REST, WebSocket and MCP:

| Setting | Default | Meaning |
| --- | --- | --- |
| `safety.maxNozzleTemp` | 300 | Maximum nozzle temperature (°C) |
| `safety.maxBedTemp` | 120 | Maximum bed temperature |
| `safety.maxChamberTemp` | 65 | Maximum chamber temperature |
| `safety.maxJogMm` | 100 | Maximum travel per jog command |
| `safety.allowGcode` | `true` | Allow arbitrary G-code; turn it off when an AI or an external system is in control |
| `safety.blockedGcodes` | `M502`, `M997` | Blocked commands (EEPROM reset, firmware update) |

Temperatures inside G-code sent directly (`M104`, `M109`, `M140`, `M190`, `M141`, `M191`) are checked too. Homing and axis movement are refused while the printer is printing.

## REST API

Full specification: `GET /openapi.json`. Condensed version for AI: [llms.txt](llms.txt) ([Vietnamese](llms.vi.txt)).

### Printing a file

```bash
# Upload and print now, in one step
curl -X POST http://127.0.0.1:7790/api/print \
  -H "x-api-key: p3d_xxx" \
  -F "printerId=prn_1a2b3c4d5e6f" -F "mode=now" -F "confirmBedClear=true" \
  -F "file=@benchy.gcode"

# Download from a URL and queue it
curl -X POST http://127.0.0.1:7790/api/print \
  -H "x-api-key: p3d_xxx" -H "content-type: application/json" \
  -d '{"printerId":"prn_1a2b3c4d5e6f","url":"https://example.com/benchy.gcode","mode":"queue"}'

# Print a file already in the library
curl -X POST http://127.0.0.1:7790/api/jobs \
  -H "x-api-key: p3d_xxx" -H "content-type: application/json" \
  -d '{"printerId":"prn_1a2b3c4d5e6f","fileId":"fil_7c1d2e3f4a5b","mode":"now"}'
```

For Bambu Lab: send a sliced `.gcode.3mf`, choose `plate`, set `useAms` and pass `amsMapping` to map filaments to AMS trays; the options `timelapse`, `bedLeveling`, `flowCalibration` and `vibrationCalibration` are also available.

A job moves through `queued` → `uploading` → `starting` → `printing` → `completed`, or stops at `paused`, `failed` or `canceled`.

### Controlling a printer

```bash
curl -X POST http://127.0.0.1:7790/api/printers/prn_1a2b3c4d5e6f/command \
  -H "x-api-key: p3d_xxx" -H "content-type: application/json" \
  -d '{"action":"temperature","params":{"heater":"bed","target":60}}'

curl http://127.0.0.1:7790/api/printers/prn_1a2b3c4d5e6f/snapshot \
  -H "x-api-key: p3d_xxx" -o snapshot.jpg
```

The available `action` values: `pause`, `resume`, `cancel`, `temperature`, `home`, `jog`, `fan`, `speed`, `light`, `gcode`, `loadFilament`, `unloadFilament`, `emergencyStop`, `connect`. Each command also has its own endpoint, such as `POST /api/printers/:id/pause`, `/temperature` and `/emergency-stop`.

Loading and unloading filament works differently per printer: Marlin (OctoPrint) and Klipper use basic extrusion commands, so they work on any firmware; Klipper prefers the `LOAD_FILAMENT`/`UNLOAD_FILAMENT` macros when the printer has them; Bambu uses its own AMS commands and takes an extra `slot`. The printer heats up before extruding if the nozzle is cold, and refuses below 170°C or while printing. PrusaLink does not expose arbitrary G-code, so it is not supported there.

### Errors

```json
{ "error": { "code": "conflict", "key": "error.bed_not_clear", "params": { "name": "Lab P1S" }, "message": "...", "details": null } }
```

`key` is a stable code a client can translate or branch on, with `params` for its placeholders; `message` is already translated according to `x-locale`, `?lang=` or `accept-language`. WebSocket and MCP errors use the same object. Job errors and printer status messages carry `errorKey`/`errorParams` and `messageKey`/`messageParams` the same way.

## WebSocket

```js
const ws = new WebSocket('ws://127.0.0.1:7790/ws?apiKey=p3d_xxx')
ws.onmessage = (event) => {
  const message = JSON.parse(event.data)
  if (message.type === 'event' && message.event === 'printer.status') console.log(message.payload)
}
ws.onopen = () => {
  ws.send(JSON.stringify({ type: 'subscribe', payload: { events: ['status', 'job'] } }))
  ws.send(JSON.stringify({ id: 1, type: 'printer.command', payload: { printerId: 'prn_1a2b3c4d5e6f', action: 'light', params: { on: true } } }))
}
```

Event channels: `status` (`printer.status`), `printer` (`printer.changed`), `job` (`job.created`, `job.updated`, `job.finished`, ...), `file`, `tunnel`, `log`. The full command list is in [llms.txt](llms.txt).

## MCP

### Streamable HTTP

```bash
claude mcp add --transport http 3d-printagent http://127.0.0.1:7790/mcp --header "x-api-key: p3d_xxx"
```

### stdio

```json
{
  "mcpServers": {
    "3d-printagent": {
      "command": "npx",
      "args": ["-y", "@hyydev/3d-printagent", "mcp"],
      "env": { "PRINTAGENT3D_URL": "http://127.0.0.1:7790", "PRINTAGENT3D_API_KEY": "p3d_xxx" }
    }
  }
}
```

Running from source, use `"command": "node", "args": ["/path/to/3d-printagent/bin/3d-printagent.js", "mcp"]` instead. By default stdio is a bridge to the running agent; `--standalone` loads the printers itself when no agent is running (do not use it alongside the agent, as both processes would connect to the same printer).

34 tools: read printer status, add and remove printers, scan the LAN, manage the library, print files, work the queue, read temperature history per printer and per job, pause/resume/cancel, temperature, G-code, home, jog, fans, speed, light, load/unload filament, emergency stop, confirm the bed is clear, and `get_snapshot`, which returns a camera image so the model can look at the print itself.

## Public tunnel

The Tunnel tab in the web UI, or `3d-printagent tunnel cloudflare|ngrok`.

- **Cloudflare**: without an account, use a quick tunnel (the `*.trycloudflare.com` address changes on every run). With an account, enter a named tunnel token and a fixed hostname.
- **ngrok**: enter an authtoken, optionally a fixed domain and a region.

A tunnel cannot start while API keys are disabled or when no key exists. Every request through the tunnel must send a key, including the web UI: the browser asks for the key on first use.

## Data layout

```
~/.3d-printagent/
├── config.json      # config, API key, tunnel
├── printers.json    # printers, connection details
├── data.db          # SQLite: job history, temps/fans/speed every 5s, spools, maintenance
├── library/         # G-code/3MF files, preview images, index.json
├── prompts/         # optional: system prompts overriding src/core/prompts
├── tmp/             # temp files during upload
└── logs/            # daily logs
```

## Running in the background

`3d-printagent service install` registers the agent to start at login: launchd on macOS (`~/Library/LaunchAgents`), a systemd user service on Linux, Task Scheduler on Windows. Remove it with `service uninstall`. The same is available on the Settings tab when the UI is open on the machine running the agent.

## Development

```bash
yarn install
yarn dev          # agent with node --watch
yarn ui:dev       # Vite dev server, proxies /api, /ws, /mcp to port 7790
yarn test         # driver, queue and metadata tests
yarn lint
yarn --cwd ui lint
```

The web UI uses React 19, Vite, Tailwind CSS v4 and shadcn/ui; it lives in `ui/` and builds into `web/`.

## License

MIT
