#!/bin/sh
# Push the custom card into Home Assistant and force browsers to pick it up.
#
# Home Assistant registers Lovelace resources by plain URL, with no version
# query, so a changed file keeps being served from the browser cache. The first
# attempt at iterating on this card looked like a layout bug for exactly that
# reason: the page was running the previous build. Every deploy here therefore
# rewrites the resource URL with a hash of the file, which makes it a new URL
# whenever the contents change and leaves the cache alone when they do not.
#
# Needs: kubectl with a context reaching the cluster, and HA_TOKEN in the
# environment for the WebSocket API.

set -eu

CARD="${CARD:-$(dirname "$0")/www/power-flow-card.js}"
CONTEXT="${KUBE_CONTEXT:-}"
NAMESPACE="${HA_NAMESPACE:-home-assistant}"
POD="${HA_POD:-home-assistant-0}"
CONTAINER="${HA_CONTAINER:-home-assistant}"
REMOTE_DIR="${HA_WWW_DIR:-/config/www/ha-kiosk}"
WS_CLIENT="${WS_CLIENT:-$(dirname "$0")/tools/ha_ws.py}"

: "${HA_TOKEN:?set HA_TOKEN to a Home Assistant long-lived access token}"
: "${HA_WS_URL:=wss://homeassistant.example.net/api/websocket}"
export HA_TOKEN HA_WS_URL

# kubectl takes --context only when one is named; passing an empty string
# selects no context and fails. A wrapper keeps the arguments as arguments:
# building a "--context x" string and leaving it unquoted would rely on word
# splitting, which breaks on a context name containing a space.
kube() {
    if [ -n "$CONTEXT" ]; then
        kubectl --context "$CONTEXT" "$@"
    else
        kubectl "$@"
    fi
}

name="$(basename "$CARD")"
hash="$(shasum -a 256 "$CARD" | cut -c1-12)"
url="/local/$(basename "$REMOTE_DIR")/$name?v=$hash"

echo "Deploying $name ($hash)"

kube -n "$NAMESPACE" exec "$POD" -c "$CONTAINER" -- \
    mkdir -p "$REMOTE_DIR"
kube -n "$NAMESPACE" cp "$CARD" \
    "$NAMESPACE/$POD:$REMOTE_DIR/$name" -c "$CONTAINER" 2>/dev/null

# Find the existing resource for this card, whatever version it currently
# carries, and point it at the new URL. Creating a second resource for the same
# file would load the card twice and fail on the duplicate element name.
python3 - "$url" <<'PY'
import json, os, subprocess, sys

url = sys.argv[1]
base = url.split("?", 1)[0]
client = os.environ["WS_CLIENT"]


def ws(commands):
    out = subprocess.run(
        [sys.executable, "-I", client],
        input=json.dumps(commands),
        capture_output=True,
        text=True,
        check=True,
    )
    return [json.loads(line) for line in out.stdout.splitlines() if line.startswith("{")]


existing = ws([{"type": "lovelace/resources"}])[0]["result"]
match = next((r for r in existing if r["url"].split("?", 1)[0] == base), None)

if match is None:
    ws([{"type": "lovelace/resources/create", "res_type": "module", "url": url}])
    print(f"registered {url}")
elif match["url"] == url:
    print(f"unchanged {url}")
else:
    ws([{ "type": "lovelace/resources/update", "resource_id": match["id"],
          "res_type": "module", "url": url }])
    print(f"updated   {url}")
PY

echo "Reload the dashboard to pick it up."
