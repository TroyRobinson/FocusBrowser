#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PNG="$ROOT_DIR/assets/icon.png"
ICONSET_DIR="$ROOT_DIR/assets/icon.iconset"
ICNS_OUT="$ROOT_DIR/assets/icon.icns"

if [[ ! -f "$PNG" ]]; then
  echo "Missing $PNG. Run 'npm run icons:svg2png' first." >&2
  exit 1
fi

rm -rf "$ICONSET_DIR" "$ICNS_OUT"
mkdir -p "$ICONSET_DIR"

# Generate required iconset PNGs
for s in 16 32 64 128 256 512; do
  sips -z $s $s "$PNG" --out "$ICONSET_DIR/icon_${s}x${s}.png" >/dev/null
  s2=$((s*2))
  sips -z $s2 $s2 "$PNG" --out "$ICONSET_DIR/icon_${s}x${s}@2x.png" >/dev/null
done

cp "$PNG" "$ICONSET_DIR/icon_1024x1024.png"

# Build .icns
iconutil -c icns "$ICONSET_DIR" -o "$ICNS_OUT"

echo "Built $ICNS_OUT"
