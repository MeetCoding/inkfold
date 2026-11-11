#!/usr/bin/env bash
# Builds dist/inkfold-<version>.zip from extension/, ready to upload to the Chrome Web Store.
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' extension/manifest.json | head -1)
mkdir -p dist
out="dist/inkfold-${version}.zip"
rm -f "$out"
(cd extension && zip -qr -X "../$out" . -x '.*' -x '*/.*')
echo "Created $out ($(du -h "$out" | cut -f1))"
