#!/bin/sh
# Install the Home Assistant kiosk on this machine. Run it on the Pi, as the
# user whose labwc session autologs in.
#
# Safe to re-run: it backs up anything it replaces and leaves an existing
# config and token alone.

set -eu

SRC="$(cd "$(dirname "$0")" && pwd)"
BIN="$HOME/.local/bin"
CONFIG_DIR="$HOME/.config/ha-kiosk"
LABWC_DIR="$HOME/.config/labwc"
STAMP="$(date +%Y%m%d-%H%M%S)"

echo "Installing from $SRC"

mkdir -p "$BIN" "$CONFIG_DIR" "$LABWC_DIR" "$HOME/.local/share/ha-kiosk"
chmod 700 "$CONFIG_DIR"

for script in ha-kiosk-launch ha-kiosk-seed-token ha-kiosk-screen; do
    install -m 755 "$SRC/bin/$script" "$BIN/$script"
    echo "  installed $BIN/$script"
done

# Panel blanking runs as a system service templated on the kiosk user, so it
# keeps the hours even if the graphical session is broken.
if [ -f "$SRC/systemd/ha-kiosk-screen.service" ]; then
    sudo install -m 644 "$SRC/systemd/ha-kiosk-screen.service" \
        /etc/systemd/system/ha-kiosk-screen@.service
    sudo systemctl daemon-reload
    sudo systemctl enable --now "ha-kiosk-screen@$(id -un)" >/dev/null 2>&1 || true
    echo "  installed and started ha-kiosk-screen@$(id -un)"
fi

if [ -f "$LABWC_DIR/autostart" ]; then
    cp -a "$LABWC_DIR/autostart" "$LABWC_DIR/autostart.bak-$STAMP"
    echo "  backed up previous autostart to $LABWC_DIR/autostart.bak-$STAMP"
fi
install -m 644 "$SRC/labwc/autostart" "$LABWC_DIR/autostart"
echo "  installed $LABWC_DIR/autostart"

if [ -f "$CONFIG_DIR/env" ]; then
    echo "  kept existing $CONFIG_DIR/env"
else
    install -m 600 "$SRC/config/ha-kiosk.env.example" "$CONFIG_DIR/env"
    echo "  installed $CONFIG_DIR/env from the example; check HA_URL and HA_DASHBOARD"
fi

if [ -f "$CONFIG_DIR/token" ]; then
    chmod 600 "$CONFIG_DIR/token"
    echo "  kept existing $CONFIG_DIR/token"
else
    echo
    echo "No token yet. Create a long-lived access token in Home Assistant"
    echo "(profile, Security tab) and write it to $CONFIG_DIR/token:"
    echo
    echo "  install -m 600 /dev/null $CONFIG_DIR/token"
    echo "  printf '%s' '<token>' > $CONFIG_DIR/token"
    echo
    echo "Without it the kiosk still starts, but shows the login screen."
fi

echo
echo "Done. Apply it with:  sudo systemctl restart display-manager"
