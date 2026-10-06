#!/bin/sh
# Build the macOS app and install it.
#
#   macos/build.sh               release build (Apple silicon + Intel) → /Applications/Hub.app (or ~/Applications)
#   macos/build.sh --no-install  release build in macos/.build/Hub.app only (macos/release.sh uses it)
#   macos/build.sh --debug       debug build with the self-test → macos/.build/Hub-debug.app
#                                (separate bundle id, so its settings and permissions don't mix)
#
# The version is macos/VERSION. Signed ad hoc (no Apple account): fine on this
# Mac; a copy on another Mac is blocked once (System Settings → Privacy &
# Security → Open Anyway).
set -eu

DIR=$(cd "$(dirname "$0")" && pwd)
VERSION=$(cat "$DIR/VERSION")
MODE=release NAME=Hub ID=com.matheuscorreiag.hub INSTALL=yes
case "${1:-}" in
  --debug) MODE=debug NAME=Hub-debug ID=com.matheuscorreiag.hub.debug INSTALL=no ;;
  --no-install) INSTALL=no ;;
  "") ;;
  *) echo "usage: $0 [--debug | --no-install]" >&2; exit 1 ;;
esac

if [ "$MODE" = release ]; then
  ARCHS="--arch arm64 --arch x86_64"
else
  ARCHS=""
fi
# shellcheck disable=SC2086 # ARCHS is two flags or none
swift build -c "$MODE" $ARCHS --package-path "$DIR"
# shellcheck disable=SC2086
BIN="$(swift build -c "$MODE" $ARCHS --package-path "$DIR" --show-bin-path)/Hub"

APP="$DIR/.build/$NAME.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/Hub"
sed -e "s/__ID__/$ID/" -e "s/__NAME__/$NAME/" -e "s/__VERSION__/$VERSION/g" "$DIR/Info.plist" >"$APP/Contents/Info.plist"
swift "$DIR/make-icon.swift" "$DIR/../public/icon.svg" "$APP/Contents/Resources/AppIcon.icns"
codesign --force --sign - "$APP"

if [ "$INSTALL" = no ]; then
  echo "built: $APP ($VERSION)"
  exit 0
fi

DEST=/Applications
[ -w "$DEST" ] || DEST="$HOME/Applications"
mkdir -p "$DEST"
if pgrep -xq Hub; then osascript -e 'quit app "Hub"' 2>/dev/null || true; sleep 1; fi
rm -rf "$DEST/Hub.app"
ditto "$APP" "$DEST/Hub.app"
echo "installed: $DEST/Hub.app ($VERSION)"
