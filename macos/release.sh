#!/bin/sh
# Publish the macOS app as a GitHub release: builds Mothership.app (Apple silicon +
# Intel), zips it and creates the release macos-v<VERSION> on the current
# commit with the zip attached. Bump macos/VERSION and commit/push first.
#
#   macos/release.sh
set -eu

DIR=$(cd "$(dirname "$0")" && pwd)
VERSION=$(cat "$DIR/VERSION")
TAG="macos-v$VERSION"
ZIP="$DIR/.build/Mothership-macOS-$VERSION.zip"

cd "$DIR/.."
if [ -n "$(git status --porcelain)" ]; then echo "commit your changes first (the release is built from a commit)" >&2; exit 1; fi
git fetch -q origin
if [ "$(git rev-parse HEAD)" != "$(git rev-parse '@{u}')" ]; then echo "push first: the release tags the pushed commit" >&2; exit 1; fi
if gh release view "$TAG" >/dev/null 2>&1; then echo "$TAG already exists — bump macos/VERSION" >&2; exit 1; fi

"$DIR/build.sh" --no-install
rm -f "$ZIP"
ditto -c -k --keepParent "$DIR/.build/Mothership.app" "$ZIP" # keeps the bundle and its signature intact

NOTES="$DIR/.build/release-notes.md"
cat >"$NOTES" <<NOTES
The macOS app: a native window around the panel, with every ⌘ shortcut, notifications and a Dock badge, and a menu-bar switch for the server. Apple silicon and Intel, macOS 14 or later.

**Install**
1. Download **Mothership-macOS-$VERSION.zip** below, unzip it and move **Mothership.app** to Applications.
2. Open it. It isn't signed with an Apple developer account, so macOS blocks it the first time: open **System Settings → Privacy & Security**, scroll down and click **Open Anyway** (or run \`xattr -dr com.apple.quarantine /Applications/Mothership.app\`).
3. Allow notifications when it asks.

**On a Mac that doesn't run the server** it's a client. Sign the Mac into Tailscale (with a login the server allows), then in the app choose **Connect to Another Mac…** (or Settings, ⌘,) and enter the server's Tailscale address, \`https://<mac>.<tailnet>.ts.net\`. Turning the server on or off only works on the server's own Mac.
NOTES

gh release create "$TAG" "$ZIP" --target "$(git rev-parse HEAD)" --title "Mothership for macOS $VERSION" --notes-file "$NOTES"
echo "released: $TAG"
