#!/bin/sh
set -eu
target=${1:?target path required}
backup=${2:?backup path required}
test -f "$backup"
cp "$backup" "$target"
printf '%s\n' "rollback restored: $target"
