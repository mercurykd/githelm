#!/bin/sh
# Git Helm editor shim.
#
# git runs this for GIT_SEQUENCE_EDITOR / GIT_EDITOR. It delegates to node,
# which hands the file content to the extension over HTTP, waits for the
# extension to send the edited content back, writes it and exits.
exec "$GITHELM_NODE" "$GITHELM_SHIM" "$@"
