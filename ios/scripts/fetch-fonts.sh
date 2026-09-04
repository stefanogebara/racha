#!/usr/bin/env bash
# Fetches the three typefaces the design system asks for.
#
# They are NOT committed: all three are SIL Open Font License, which is
# redistributable, but vendoring binaries into an app repo means nobody can tell
# at a glance which version is in there or where it came from. This script makes
# the provenance explicit and the update a one-liner.
#
# The app renders correctly without them — Typo.font() falls back to the system
# serif/sans/mono. It just loses some warmth.
#
#   ./scripts/fetch-fonts.sh
#   # then, in Xcode: the files land in Racha/Resources/Fonts/ and the
#   # synchronised folder group picks them up. Add them to
#   # INFOPLIST_KEY_UIAppFonts (or an Info.plist UIAppFonts array).
set -euo pipefail

cd "$(dirname "$0")/.."
DEST="Racha/Resources/Fonts"
mkdir -p "$DEST"

fetch() {
  local name="$1" url="$2"
  if [[ -f "$DEST/$name" ]]; then
    echo "· $name já existe"
    return
  fi
  echo "↓ $name"
  curl -fsSL "$url" -o "$DEST/$name"
}

BASE="https://raw.githubusercontent.com/google/fonts/main"
fetch "DMSans.ttf"          "$BASE/ofl/dmsans/DMSans%5Bopsz%2Cwght%5D.ttf"
fetch "InstrumentSerif-Regular.ttf" "$BASE/ofl/instrumentserif/InstrumentSerif-Regular.ttf"
fetch "JetBrainsMono.ttf"   "$BASE/ofl/jetbrainsmono/JetBrainsMono%5Bwght%5D.ttf"

cat <<'NOTE'

Feito. Faltam dois passos no Xcode:

  1. Confirme que os arquivos aparecem em Racha/Resources/Fonts (a pasta é
     sincronizada, então deve ser automático).
  2. Adicione ao build setting INFOPLIST_KEY_UIAppFonts do alvo Racha:
       Resources/Fonts/DMSans.ttf
       Resources/Fonts/InstrumentSerif-Regular.ttf
       Resources/Fonts/JetBrainsMono.ttf

O DM Sans e o JetBrains Mono são variáveis; o PostScript name das instâncias
é DMSans-Regular / -Medium / -Bold e JetBrainsMono-Regular, que é o que
Typo.Face espera.
NOTE
