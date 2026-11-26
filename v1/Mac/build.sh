#!/bin/bash
# Breakpad for Mac: builds the shell, bundles the web app inside, signs. Usage: ./build.sh [install]
set -euo pipefail
MAC="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$MAC")"
SCRATCH="$ROOT/Niepotrzebne/build"
cd "$MAC"
nice -n 10 swift build -c release --scratch-path "$SCRATCH" -j 4
ICONS="$ROOT/Niepotrzebne/icon"
if [ ! -f "$ICONS/AppIcon.icns" ]; then
  mkdir -p "$ICONS"
  swift "$MAC/make-icon.swift" "$ICONS/AppIcon.iconset"
  iconutil -c icns "$ICONS/AppIcon.iconset" -o "$ICONS/AppIcon.icns"
fi
OUT="$ROOT/Niepotrzebne/Breakpad.app"
rm -rf "$OUT"
mkdir -p "$OUT/Contents/MacOS" "$OUT/Contents/Resources/web"
cp "$SCRATCH/release/Breakpad" "$OUT/Contents/MacOS/Breakpad"
cp "$ICONS/AppIcon.icns" "$OUT/Contents/Resources/AppIcon.icns"
cp -R "$ROOT/index.html" "$ROOT/app.css" "$ROOT/icon.svg" "$ROOT/src" "$ROOT/sounds" "$OUT/Contents/Resources/web/"
VERSION="$(cat "$ROOT/VERSION" 2>/dev/null || echo 1.0)"
BUILD="$(git -C "$ROOT" rev-list --count HEAD 2>/dev/null || echo 1)"
cat > "$OUT/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>fun.gzowo.breakpad</string>
<key>CFBundleName</key><string>Breakpad</string>
<key>CFBundleDisplayName</key><string>Breakpad</string>
<key>CFBundleExecutable</key><string>Breakpad</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>$VERSION</string>
<key>CFBundleVersion</key><string>$BUILD</string>
<key>CFBundleIconFile</key><string>AppIcon</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>LSApplicationCategoryType</key><string>public.app-category.music</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSPrincipalClass</key><string>NSApplication</string>
<key>NSHumanReadableCopyright</key><string>Gzowo Labs</string>
</dict></plist>
PLIST
IDENTITY="$(security find-identity -v -p codesigning | sed -n 's/.*"\(Apple Development[^"]*\)".*/\1/p' | head -1)"
codesign --force --deep --sign "${IDENTITY:--}" "$OUT" 2>/dev/null
if [ "${1:-}" = "install" ]; then
  rm -rf "/Applications/Breakpad.app"
  cp -R "$OUT" "/Applications/Breakpad.app"
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "/Applications/Breakpad.app" >/dev/null 2>&1 || true
  echo "/Applications/Breakpad.app"
else
  echo "$OUT"
fi
