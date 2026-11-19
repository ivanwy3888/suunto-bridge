#!/bin/zsh
set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="颂拓记录搬家"
APP="build/${APP_NAME}.app"
export COPYFILE_DISABLE=1

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

swiftc -O -swift-version 5 \
  -target arm64-apple-macos13.0 \
  -framework Cocoa -framework WebKit \
  Sources/main.swift \
  -o "$APP/Contents/MacOS/SuuntoBridge"

cp Info.plist "$APP/Contents/Info.plist"
cp -R Resources/web "$APP/Contents/Resources/web"
cp Resources/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
mkdir -p "$APP/Contents/Resources/bin"
cp Resources/bin/suuntool "$APP/Contents/Resources/bin/suuntool"
chmod +x "$APP/Contents/Resources/bin/suuntool"

find "$APP" -name '.DS_Store' -delete
xattr -cr "$APP"
codesign --force --sign - "$APP" >/dev/null 2>&1 || true
echo "built: $APP"
