#!/usr/bin/env bash
# Tudo que dá pra verificar sem um Mac. Roda de qualquer diretório.
#
# O que NÃO está aqui: compilar. Ver docs/verification.md.
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0
for check in verify-money check-shaders check-pbxproj check-swift; do
  printf '\n\033[1m── %s ──\033[0m\n' "$check"
  if ! python3 "scripts/$check.py"; then fail=1; fi
done

printf '\n'
if [[ $fail -eq 0 ]]; then
  printf '\033[32mtudo verde\033[0m — mas nada disso compila Swift. Num Mac:\n'
  printf "  xcodebuild test -scheme Racha -destination 'platform=iOS Simulator,name=iPhone 16 Pro'\n"
else
  printf '\033[31mfalhou\033[0m\n'
fi
exit $fail
