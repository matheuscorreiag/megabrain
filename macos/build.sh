#!/bin/sh
# Build the macOS app and install it.
#
#   macos/build.sh               release build (Apple silicon + Intel) → /Applications/Mothership.app (or ~/Applications)
#   macos/build.sh --no-install  release build in macos/.build/Mothership.app only (macos/release.sh uses it)
#   macos/build.sh --debug       debug build with the self-test → macos/.build/Mothership-debug.app
#                                (separate bundle id, so its settings and permissions don't mix)
#
# The version is macos/VERSION. Signed ad hoc (no Apple account): fine on this
# Mac; a copy on another Mac is blocked once (System Settings → Privacy &
# Security → Open Anyway).
set -eu

DIR=$(cd "$(dirname "$0")" && pwd)
VERSION=$(cat "$DIR/VERSION")
MODE=release NAME=Mothership ID=com.matheuscorreiag.mothership INSTALL=yes
case "${1:-}" in
  --debug) MODE=debug NAME=Mothership-debug ID=com.matheuscorreiag.mothership.debug INSTALL=no ;;
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
BIN="$(swift build -c "$MODE" $ARCHS --package-path "$DIR" --show-bin-path)/Mothership"

APP="$DIR/.build/$NAME.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/Mothership"
sed -e "s/__ID__/$ID/" -e "s/__NAME__/$NAME/" -e "s/__VERSION__/$VERSION/g" "$DIR/Info.plist" >"$APP/Contents/Info.plist"
swift "$DIR/make-icon.swift" "$DIR/AppIcon.svg" "$APP/Contents/Resources/AppIcon.icns"
codesign --force --sign - "$APP"

if [ "$INSTALL" = no ]; then
  echo "built: $APP ($VERSION)"
  exit 0
fi

DEST=/Applications
[ -w "$DEST" ] || DEST="$HOME/Applications"
mkdir -p "$DEST"
if pgrep -xq Mothership; then osascript -e 'quit app "Mothership"' 2>/dev/null || true; sleep 1; fi
rm -rf "$DEST/Mothership.app"
ditto "$APP" "$DEST/Mothership.app"
echo "installed: $DEST/Mothership.app ($VERSION)"
