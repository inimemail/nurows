#!/bin/sh
set -eu
target=${1:?target file required}
baseline=${2:?baseline file required}
cp "$baseline" "$target"
test "$(shasum -a 256 "$target" | awk '{print $1}')" = "$(shasum -a 256 "$baseline" | awk '{print $1}')"
printf '%s\n' 'restored baseline hash on independent copy'
