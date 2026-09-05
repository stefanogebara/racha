#!/usr/bin/env bash
# Fetches the one typeface the design system asks for: Archivo, variable, with
# the width axis the poster cut depends on.
#
# It is NOT committed: it is SIL Open Font License, which is
# redistributable, but vendoring binaries into an app repo means nobody can tell
# at a glance which version is in there or where it came from. This script makes
# the provenance explicit and the update a one-liner.
#
# The app renders correctly without it — Typo.font() falls back to San Francisco
# with its width variants (compressed for the poster cut). It loses the voice,
# not the hierarchy.
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
fetch "Archivo.ttf"  "$BASE/ofl/archivo/Archivo%5Bwdth%2Cwght%5D.ttf"

cat <<'NOTE'

Feito. Faltam dois passos no Xcode:

  1. Confirme que os arquivos aparecem em Racha/Resources/Fonts (a pasta é
     sincronizada, então deve ser automático).
  2. Adicione ao build setting INFOPLIST_KEY_UIAppFonts do alvo Racha:
       Resources/Fonts/Archivo.ttf

O Archivo é variável (eixos wdth 62–125 e wght 100–900). Typo.archivo() pede a
instância por atributo de variação do CoreText, então o PostScript name que o
UIFont precisa achar é só a família: "Archivo".
NOTE
