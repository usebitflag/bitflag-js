#!/usr/bin/env bash
# Fetches the pinned protocol release, verifies its checksum and extracts it to build/protocol/<version>.
#
#   scripts/fetch-protocol-fixtures.sh
#
# The release is named in protocol.lock.json. It is downloaded with the GitHub CLI, so GH_TOKEN must be able to read
# the (private) protocol repository. To use an archive you already have, for example while the release is being
# prepared, set PROTOCOL_ARCHIVE to its path; it is still checked against the checksum in the lock file.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
lock="$root/protocol.lock.json"

field() {
  node -e 'const l = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(String(l[process.argv[2]] ?? ""));' "$lock" "$1"
}

repository="$(field repository)"
version="$(field version)"
asset="$(field asset)"
expected="$(field sha256)"

if [[ -z "$expected" ]]; then
  echo "protocol.lock.json has no sha256: the protocol release $version has not been pinned yet." >&2
  echo "Publish the release, then put the checksum from its SHA256SUMS file into protocol.lock.json." >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

if [[ -n "${PROTOCOL_ARCHIVE:-}" ]]; then
  cp "$PROTOCOL_ARCHIVE" "$work/$asset"
else
  gh release download "v$version" --repo "$repository" --pattern "$asset" --dir "$work"
fi

if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$work/$asset" | cut -d' ' -f1)"
else
  actual="$(shasum -a 256 "$work/$asset" | cut -d' ' -f1)"
fi

if [[ "$actual" != "$expected" ]]; then
  echo "Checksum mismatch for $asset." >&2
  echo "  pinned: $expected" >&2
  echo "  actual: $actual" >&2
  exit 1
fi

target="$root/build/protocol/$version"
rm -rf "$target"
mkdir -p "$target"
tar -xzf "$work/$asset" -C "$target" --strip-components=1

echo "Protocol $version verified and extracted to build/protocol/$version"
