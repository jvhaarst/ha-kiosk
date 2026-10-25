#!/bin/sh
# Run every linter this repository uses. CI runs exactly this, so a clean run
# here means a clean run there.
#
# Needs shellcheck, uv and npx on PATH. Nothing is installed globally: uvx and
# npx fetch pinned versions into their own caches.

set -eu

cd "$(dirname "$0")"

RUFF="${RUFF_VERSION:-0.14.2}"
BIOME="${BIOME_VERSION:-2.3.8}"

status=0
run() {
    printf '\n== %s ==\n' "$1"
    shift
    "$@" || status=1
}

# The paths are spelled out at every call rather than held in a variable or
# wrapped in a helper. A variable holding several paths only works by word
# splitting, and a helper passed through `run` looks uncalled to shellcheck;
# both draw warnings that would have to be suppressed. A little repetition is
# the honest version.
#
# Two files are named explicitly because they have no suffix to find them by:
# bin/ha-kiosk-launch is POSIX sh and bin/ha-kiosk-seed-token is Python.
run "shellcheck" shellcheck -s sh \
    bin/ha-kiosk-launch install.sh uninstall.sh deploy-card.sh lint.sh
run "ruff check" uvx "ruff@$RUFF" check tools/ bin/ha-kiosk-seed-token
run "ruff format" uvx "ruff@$RUFF" format --check tools/ bin/ha-kiosk-seed-token
run "biome" npx --yes "@biomejs/biome@$BIOME" lint www/

if [ "$status" -eq 0 ]; then
    printf '\nall clean\n'
else
    printf '\nlint failed\n' >&2
fi
exit "$status"
