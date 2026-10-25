# ha-kiosk

A wall-mounted Home Assistant panel: a Raspberry Pi 3 Model B behind a 720x720
Pimoroni HyperPixel 4.0 Square. Chromium runs full-screen with no desktop, no
browser chrome and no login screen, and comes back by itself if it crashes or
the power drops.

Four screens, switched by buttons along the bottom:

| Screen | Shows |
| --- | --- |
| Stroom | Power flow between grid, solar, house and EV charger |
| Lampen | Lights, with brightness sliders and toggles on the cards |
| CV&Airco | Heating and air conditioning |
| Deurbel | Doorbell camera, with visitor, person and motion state |

It jumps to the doorbell by itself when the bell rings, and returns to the
first screen after two minutes with nobody touching it.

## Requirements

- Raspberry Pi OS (Debian 13 trixie) with the **labwc** compositor
- A HyperPixel 4.0 Square, enabled with `dtoverlay=vc4-kms-dpi-hyperpixel4sq`
  in `/boot/firmware/config.txt`
- Chromium and Python 3 on the Pi; the scripts use the standard library only
- Home Assistant 2026.10 or newer
- `kubectl` reaching the cluster, if Home Assistant runs in Kubernetes; the
  deploy scripts copy files into its container

## Install on the Pi

Copy this directory over and run the installer as the autologin user:

```sh
rsync -a ha-kiosk/ <user>@<kiosk-host>:ha-kiosk/
ssh <user>@<kiosk-host> 'sh ha-kiosk/install.sh'
```

Set the dashboard and the token in `~/.config/ha-kiosk/env`:

```sh
HA_URL=https://homeassistant.example.net
HA_DASHBOARD=/kiosk-flow/stroom
```

Create a long-lived access token in Home Assistant under your profile,
Security tab, and write it to the token file:

```sh
install -m 600 /dev/null ~/.config/ha-kiosk/token
printf '%s' '<token>' > ~/.config/ha-kiosk/token
```

Apply with `sudo systemctl restart display-manager`, or reboot. Without a token
the kiosk still starts; it just shows the login screen.

## Install into Home Assistant

The two custom cards are served from Home Assistant's `www` directory and
registered as Lovelace resources. `deploy-card.sh` does both:

```sh
cp kiosk.env.example kiosk.env && $EDITOR kiosk.env
set -a; . ./kiosk.env; set +a

./deploy-card.sh                              # the power-flow card
CARD=www/kiosk-shell-card.js ./deploy-card.sh # the navigation shell
python3 tools/build-dashboard.py              # the dashboard itself
```

Everything site-specific lives in `kiosk.env`: the Home Assistant address and
token, where its container is, which entities each screen shows, and what to
call them. `kiosk.env.example` documents every setting. `kiosk.env` is
gitignored, because it holds a token that grants full access.

The defaults built into the scripts are placeholders that show the shape of a
working setup, not a working setup. Build against them and you get a dashboard
full of entities that do not exist.

Quote any value containing a space. The file is sourced by the shell, where
`NAME=AC Belastingen` tries to run `Belastingen` as a command and the script
quietly falls back to its own default.

`python3 tools/build-dashboard.py --print` shows the config it would send
without sending it.

Hiding Home Assistant's header and sidebar needs the **Kiosk Mode** frontend
module (`NemesisRE/kiosk-mode`), installed through HACS and registered as a
resource. The dashboard carries a `kiosk_mode` block of its own, so only this
dashboard is affected.

## How it fits together

| File | Purpose |
| --- | --- |
| `bin/ha-kiosk-launch` | Starts Chromium with the kiosk flags |
| `bin/ha-kiosk-seed-token` | Logs the browser in over the DevTools Protocol |
| `labwc/autostart` | labwc session entry for the browser |
| `config/ha-kiosk.env.example` | Settings template |
| `install.sh`, `uninstall.sh` | Install and revert on the Pi |
| `www/power-flow-card.js` | The power-flow card |
| `www/kiosk-shell-card.js` | Wraps a screen and draws the nav buttons |
| `tools/build-dashboard.py` | Builds and pushes the dashboard config |
| `kiosk.env.example` | Every site-specific setting, documented |
| `tools/ha_ws.py` | Minimal Home Assistant WebSocket client |
| `deploy-card.sh` | Pushes a card and busts the browser cache |
| `lint.sh` | Runs every linter; CI runs this too |

`tools/build-dashboard.py` is the source of truth for the dashboard. Editing it
in the Home Assistant UI works, but the next run of the script overwrites it.
It only ever writes its own dashboard; others are untouched.

## Logging in without a login screen

The Home Assistant frontend ignores the `Authorization: Bearer` header that the
REST and WebSocket APIs accept. It reads its credentials from `localStorage`,
under the key `hassTokens`, and `loadTokens()` parses whatever is there without
checking where it came from. Writing that key logs the browser in.

`ha-kiosk-seed-token` attaches to the running Chromium over the DevTools
Protocol and writes it. The value is the shape `home-assistant-js-websocket`
documents for a long-lived token: `clientId` null, `refresh_token` empty, and
`access_token` set to the token. `expires` comes from the token's own `exp`
claim, because the frontend treats the token as expired once `Date.now()`
passes `expires` and then calls `refreshAccessToken()`, which throws when there
is no refresh token.

It waits for the document to actually be on the Home Assistant origin before
writing. A DevTools target reports its destination URL as soon as navigation
starts, while the document in it is still `about:blank`, whose opaque origin
rejects `localStorage` with "Access is denied for this document".

## Security

A long-lived access token grants full, unscoped access to Home Assistant for
ten years and cannot be narrowed to one dashboard. Anyone with physical access
to the Pi has both full control of Home Assistant and a readable copy of the
token. That is a reasonable trade for a panel in a private home, but it should
be a deliberate one. Give the kiosk its own token so it can be revoked on its
own, and keep `~/.config/ha-kiosk/token` at mode 600.

Chromium's DevTools port is what makes the automatic login possible. Chromium
binds it to 127.0.0.1 only, so it is reachable from the Pi itself and not from
the network.

## Linting

```sh
./lint.sh
```

shellcheck over the shell scripts, ruff over the Python, and biome over the
JavaScript. `uvx` and `npx` fetch the linters, so nothing is installed
globally, and they are unpinned so the current release always runs. CI runs
that same script, so a clean run locally means a clean run there.

Warnings fail, not just errors. Biome exits 0 on warnings unless told
otherwise, and a linter that reports a problem and exits 0 is not a gate.

The cost of running unpinned linters is that a new release can turn CI red on
a change that had nothing to do with it. That is the trade for never reviewing
a version-bump pull request for a tool that only reads the code.

## Things that cost time to find out

**labwc runs both autostart files.** Generic labwc documentation says
`~/.config/labwc/autostart` replaces `/etc/xdg/labwc/autostart`. On Raspberry Pi
OS it does not: the session runs `labwc-pi` and executes both. Putting the same
program in both gets you two of it. The panel and file manager therefore keep
running behind the full-screen browser; they are invisible and cost a few tens
of megabytes, which is cheaper than fighting the system session.

Every line in a labwc autostart needs a trailing `&`, or labwc waits for that
program to exit and never reaches the lines below it.

**Keep the launcher in the foreground.** `lwrespawn` watches the process it
starts, so backgrounding Chromium inside the launch script looks like an
instant exit and causes a respawn loop.

**Chromium refuses `--remote-debugging-port` against its default profile**, so
the kiosk needs its own `--user-data-dir`.

**Lovelace resources have no cache busting.** Home Assistant registers them by
plain URL, so a changed card keeps being served from the browser cache. An
apparent layout bug turned out to be the page running the previous build.
`deploy-card.sh` rewrites the resource URL with a hash of the file on every
push.

**Cards live in nested shadow roots.** `document.querySelector` will not find
them; a recursive walker over `shadowRoot` is needed to inspect one.

**Draw SVG in pixels, not percentages.** A 0-100 viewBox needs
`preserveAspectRatio="none"`, which squashes one axis badly in a tall narrow
column. Lines survive it, arrowheads do not. The flow card sets its viewBox
from a `ResizeObserver` and lays out every path in real pixels.

**Home Assistant replaces card elements as it re-renders.** A pending timer on
a replaced instance still fires. The idle-return countdown therefore keeps the
last interaction time on `window`, shared by every instance, and a timer that
fires re-checks it and re-arms rather than navigating. Before that, a screen
returned home on a fixed schedule no matter how much the panel was touched.

**Measure in the browser, not on paper.** The flow card's type size was settled
by substituting worst-case strings into the DOM and reading back
`getBoundingClientRect().width`. A first attempt compared `scrollWidth` to
`clientWidth` on a `flex: 1` element, whose `scrollWidth` is clamped to its own
width, so every trial reported a pass.

## Not done

- Screen blanking, or waking on motion
- Returning from the doorbell screen when the visitor sensor clears, separately
  from the two-minute idle return
