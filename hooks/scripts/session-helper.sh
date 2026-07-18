#!/bin/sh
# Thin Unix compatibility adapter. Supported runtime behavior lives in Node;
# source-only legacy callers explicitly load the byte-frozen Unix oracle.

source_path=${BASH_SOURCE:-$0}
case $source_path in
  */*) script_dir=${source_path%/*} ;;
  *) script_dir=. ;;
esac
SCRIPT_DIR=$(CDPATH= cd -- "$script_dir" && pwd -P)

if [ "${HELPER_SOURCED:-0}" = "1" ]; then
  . "$SCRIPT_DIR/../../legacy/session-helper-v3.4.3.sh"
  return 0 2>/dev/null || exit 0
fi

exec node "$SCRIPT_DIR/deep-evolve-runtime.cjs" --legacy-session-helper "$@"
