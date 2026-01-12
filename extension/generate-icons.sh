#!/bin/bash
# Generate PNG icons from SVG files
# Requires: ImageMagick (brew install imagemagick) or rsvg-convert (brew install librsvg)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ICONS_DIR="$SCRIPT_DIR/icons"

cd "$ICONS_DIR"

echo "Generating PNG icons..."

# Check for available converters
if command -v convert &> /dev/null; then
    # ImageMagick
    echo "Using ImageMagick..."
    convert -background none icon16.svg icon16.png
    convert -background none icon32.svg icon32.png
    convert -background none icon48.svg icon48.png
    convert -background none icon128.svg icon128.png
elif command -v rsvg-convert &> /dev/null; then
    # librsvg
    echo "Using rsvg-convert..."
    rsvg-convert -w 16 -h 16 icon16.svg > icon16.png
    rsvg-convert -w 32 -h 32 icon32.svg > icon32.png
    rsvg-convert -w 48 -h 48 icon48.svg > icon48.png
    rsvg-convert -w 128 -h 128 icon128.svg > icon128.png
else
    echo "Error: No SVG converter found."
    echo "Install ImageMagick: brew install imagemagick"
    echo "Or librsvg: brew install librsvg"
    echo ""
    echo "Alternative: Use an online converter or image editor to convert SVGs to PNGs."
    exit 1
fi

echo "Done! PNG icons generated:"
ls -la *.png 2>/dev/null || echo "No PNG files found"
