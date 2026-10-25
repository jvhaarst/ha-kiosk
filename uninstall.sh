#!/bin/sh
# Remove the kiosk and hand the normal Raspberry Pi desktop back.
#
# Deleting ~/.config/labwc/autostart stops the browser from being started.
# /etc/xdg/labwc/autostart runs either way on this image and brings up the panel
# and the file manager, so the normal desktop is there once the browser is gone.
# The config and token are left in place; say so and let the user delete them
# deliberately.

set -eu

BIN="$HOME/.local/bin"
CONFIG_DIR="$HOME/.config/ha-kiosk"
LABWC_DIR="$HOME/.config/labwc"

sudo systemctl disable --now "ha-kiosk-screen@$(id -un)" >/dev/null 2>&1 || true
sudo rm -f /etc/systemd/system/ha-kiosk-screen@.service
sudo systemctl daemon-reload || true
echo "removed the panel blanking service; the backlight is left as it is"

for script in ha-kiosk-launch ha-kiosk-seed-token ha-kiosk-screen; do
    rm -f "$BIN/$script" && echo "removed $BIN/$script"
done

if [ -f "$LABWC_DIR/autostart" ]; then
    rm -f "$LABWC_DIR/autostart"
    echo "removed $LABWC_DIR/autostart; the system desktop autostart applies again"
fi

echo
echo "Left in place, delete by hand if you want them gone:"
echo "  $CONFIG_DIR/env"
echo "  $CONFIG_DIR/token   (revoke the token in Home Assistant too)"
echo "  $HOME/.local/share/ha-kiosk/profile"
echo
echo "Apply with:  sudo systemctl restart display-manager"
