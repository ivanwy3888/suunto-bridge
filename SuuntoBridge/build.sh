#!/bin/zsh
set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="颂拓记录搬家"
APP="build/${APP_NAME}.app"
export COPYFILE_DISABLE=1

# 底层工具 suuntool 由第三方提供（MIT），二进制不随仓库分发
TOOL="Resources/bin/suuntool"
if [ ! -x "$TOOL" ]; then
  TOOL="$(command -v suuntool || true)"
fi
if [ -z "$TOOL" ] || [ ! -x "$TOOL" ]; then
  echo "缺少 suuntool：先安装（brew install --cask tajchert/tap/suuntool），"
  echo "或把二进制放到 SuuntoBridge/Resources/bin/suuntool" >&2
  exit 1
fi

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

swiftc -O -swift-version 5 \
  -target "$(uname -m)-apple-macos13.0" \
  -framework Cocoa -framework WebKit \
  Sources/main.swift \
  -o "$APP/Contents/MacOS/SuuntoBridge"

cp Info.plist "$APP/Contents/Info.plist"
cp -R Resources/web "$APP/Contents/Resources/web"
cp Resources/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
mkdir -p "$APP/Contents/Resources/bin"
cp "$TOOL" "$APP/Contents/Resources/bin/suuntool"
chmod +x "$APP/Contents/Resources/bin/suuntool"

find "$APP" -name '.DS_Store' -delete
xattr -cr "$APP"
codesign --force --sign - "$APP" >/dev/null 2>&1 || true
echo "built: $APP"