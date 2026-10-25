#!/bin/sh
# Run every linter this repository uses. CI runs exactly this, so a clean run
# here means a clean run there.
#
# Needs shellcheck, uv and npx on PATH. Nothing is installed globally: uvx and
# npx fetch the linters into their own caches.
#
# The linters are deliberately unpinned, so this always runs the current
# release. The cost is that a new release can turn CI red on a change that had
# nothing to do with it: biome 2.6.3 added a rule that flagged three existing
# files the day it landed. That is the trade for never having to review a
# version-bump pull request for a tool that only reads the code.
#
# Warnings fail. A linter that reports a problem and exits 0 is not a gate, and
# biome exits 0 on warnings unless told otherwise.

set -eu

cd "$(dirname "$0")"

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
run "ruff check" uvx ruff@latest check tools/ bin/ha-kiosk-seed-token
run "ruff format" uvx ruff@latest format --check tools/ bin/ha-kiosk-seed-token
run "biome" npx --yes @biomejs/biome@latest lint --error-on-warnings www/

if [ "$status" -eq 0 ]; then
    printf '\nall clean\n'
else
    printf '\nlint failed\n' >&2
fi
exit "$status"
