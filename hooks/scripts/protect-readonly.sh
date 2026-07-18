#!/bin/sh
# Legacy Unix-only compatibility entrypoint. Supported host manifests invoke
# protect-readonly.cjs directly on every platform.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$SCRIPT_DIR/protect-readonly.cjs"
