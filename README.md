# ha-kiosk

A wall-mounted Home Assistant panel: a Raspberry Pi 3 Model B behind a 720x720
Pimoroni HyperPixel 4.0 Square. Chromium runs full-screen with no desktop, no
browser chrome and no login screen, and comes back by itself if it crashes or
the power drops.

Five screens, switched by buttons along the bottom:

| Screen | Shows |
| --- | --- |
| Stroom | Power flow between grid, solar, house and EV charger |
| Lampen | Lights, with brightness sliders and toggles on the cards |
| CV&Airco | Heating and air conditioning |
| Deurbel | Doorbell camera, with visitor, person and motion state |
| Afval | Waste collection dates, colour-coded per stream |

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

## Where configuration lives

Three places, with different owners. This catches people out, so:

| File | Holds | Read by |
| --- | --- | --- |
| `~/.config/ha-kiosk/env` **on the Pi** | Home Assistant URL, which dashboard to open, token path, Chromium profile, and every `SCREEN_*` blanking setting | `ha-kiosk-launch`, `ha-kiosk-screen` |
| `kiosk.env` **on the workstation** | which entities each screen shows, their labels, and how to reach Home Assistant's container | `deploy-card.sh`, `tools/build-dashboard.py` |
| The dashboard itself, in Home Assistant | the views and cards | Home Assistant |

The blanking schedule is in the first of those, so it keeps working when Home
Assistant is down or the network drops, and Home Assistant cannot see or
override it.

A copy of the Pi's file is kept here as `pi.env` so the schedule does not live
only on an SD card. Both it and `kiosk.env` are gitignored. To refresh the copy,
or to put it back on a rebuilt Pi:

```sh
scp <user>@<kiosk-host>:.config/ha-kiosk/env ./pi.env      # pull
scp ./pi.env <user>@<kiosk-host>:.config/ha-kiosk/env      # push
ssh <user>@<kiosk-host> 'sudo systemctl restart ha-kiosk-screen@$(id -un)'
```

The long-lived access token is deliberately **not** copied. It is a credential
rather than configuration, a new one takes a minute to issue, and keeping it in
one place is the point.

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

## Backlight dimming

The stock HyperPixel overlay wires the backlight as a `gpio-backlight` on
GPIO 19, which has `max_brightness` 1: on or off, nothing between.
`overlays/hyperpixel4sq-pwmbl-overlay.dts` is a fork that drives the same pin
as PWM1 instead, giving sixteen levels:

```sh
dtc -@ -I dts -O dtb -o hyperpixel4sq-pwmbl.dtbo \
    overlays/hyperpixel4sq-pwmbl-overlay.dts
sudo cp hyperpixel4sq-pwmbl.dtbo /boot/firmware/overlays/
# then in /boot/firmware/config.txt replace
#   dtoverlay=vc4-kms-dpi-hyperpixel4sq
# with
#   dtoverlay=hyperpixel4sq-pwmbl
```

After a reboot, `/sys/class/backlight/backlight/brightness` takes 0 to 15.

**This disables the analogue headphone output.** The Pi's 3.5mm jack uses both
PWM channels, so the backlight has to take one of them. Raspberry Pi's own
`vc4-kms-dpi-panel` overlay carries the same warning. The overlay passes
`snd_bcm2835.enable_headphones=0` to make that explicit rather than letting the
two fight over PWM1.

The overlay is deliberately not named after a stock one. The kernel upgrade
hook copies overlays with `rsync -ct` and no `--delete`, so a file it does not
ship is left alone, while a same-named one would be overwritten on every
kernel upgrade. Nothing needs rebuilding per kernel: overlays are device tree
blobs, not modules. The source is kept here so that a future diff against the
upstream overlay is quick if Raspberry Pi change it.

## Panel blanking

`bin/ha-kiosk-screen` turns the backlight off outside waking hours and wakes
it briefly on a touch. It is installed as a system service,
`ha-kiosk-screen@<user>`, so the screen still comes on in the morning even if
the browser or the session has died.

```
SCREEN_WAKE_WEEKDAY=07:00
SCREEN_WAKE_WEEKEND=08:00
SCREEN_SLEEP=23:30
SCREEN_MIDDAY_OFF_DAYS=Mon,Tue,Thu,Fri
SCREEN_MIDDAY_FROM=08:30
SCREEN_MIDDAY_TO=17:00
SCREEN_TOUCH_SECONDS=60
SCREEN_BRIGHTNESS=5
```

Which works out as:

| Day | On |
| --- | --- |
| Mon, Tue, Thu, Fri | 07:00-08:30, 17:00-23:30 |
| Wed | 07:00-23:30 |
| Sat, Sun | 08:00-23:30 |

The hours are worth deriving rather than guessing. These came from the house
heating programme, which turned out not to be in Home Assistant at all: the
thermostat exposes only one slot of it at a time. Ten days of history for the
target-temperature entity gave the whole pattern instead, by counting which
switches recurred. An hour is added in the evening so the screen outlasts the
heating; the midday gap follows it exactly.

The panel is an IPS LCD, so it does not burn in the way an OLED does, but it
does retain an image when it holds the same picture for days, and a kiosk
whose navigation bar never moves is a bad case. Blanking it while nobody is
looking is the single biggest thing that helps.

Two things the daemon handles that are easy to miss. `systemd-backlight`
saves the brightness at shutdown and restores it at boot, so a Pi switched off
while blanked comes back with the backlight at 0 and looks dead; the daemon
therefore sets the correct state as soon as it starts rather than waiting for
the next transition. And the touchscreen's event node is not stable across
kernels, so it is looked up by name in `/proc/bus/input/devices` rather than
hardcoded.

It needs no root: the brightness file is writable by `video` and the touch
device readable by `input`, both of which the kiosk user is already in.

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

## License

MIT. See `LICENSE`.

## Not done

- Screen blanking, or waking on motion
- Returning from the doorbell screen when the visitor sensor clears, separately
  from the two-minute idle return
