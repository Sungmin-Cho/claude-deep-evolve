#!/bin/sh
# Thin Unix compatibility adapter. Validation, locking, and mutation are owned
# by the canonical Node dispatcher operation.

source_path=${BASH_SOURCE:-$0}
case $source_path in
  */*) script_dir=${source_path%/*} ;;
  *) script_dir=. ;;
esac
SCRIPT_DIR=$(CDPATH= cd -- "$script_dir" && pwd -P)

exec node "$SCRIPT_DIR/deep-evolve-runtime.cjs" --legacy-operation coord.queue-user-kill "$@"
