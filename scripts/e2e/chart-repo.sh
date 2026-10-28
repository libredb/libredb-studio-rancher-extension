#!/usr/bin/env bash
# Lays out the extension's Helm repository for the spec that installs it from Rancher's Extensions
# page, as gh-pages lays it out: index.yaml, the chart under assets/ and the plugin under extensions/.
#
# The chart comes from the shell's publish script, which the release workflow runs, so its annotations
# are the ones the Extensions page judges. Only the plugin's endpoint changes: a released chart names
# gh-pages, which has no build of this checkout, so here it names the same repository served at
# REPO_URL, where Rancher fetches the plugin after the install. Needs helm, jq and yq 4, as the
# publish script does.
#
# Usage: scripts/e2e/chart-repo.sh <empty output directory> <repository URL as Rancher reaches it>
set -euo pipefail

usage='usage: scripts/e2e/chart-repo.sh <empty output directory> <repository URL as Rancher reaches it>'
out="${1:?$usage}"
repo_url="${2:?$usage}"
repo_url="${repo_url%/}"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

if [ -e "$out" ] && [ -n "$(ls -A "$out")" ]; then
  echo "$out is not empty" >&2
  exit 1
fi

# The publish script writes these into the repository root; never remove one this script did not make
for made in assets charts extensions index.yaml tmp; do
  if [ -e "$made" ]; then
    echo "$root/$made exists, and the shell's publish script writes there; move it away first" >&2
    exit 1
  fi
done
trap 'rm -rf assets charts extensions index.yaml tmp' EXIT

pkg=libredb-studio
version="$(node -p "require('./pkg/${pkg}/package.json').version")"

# As the release workflow publishes to gh-pages: a GitHub build, here for a branch that has no index yet
yarn -s publish-pkgs -s libredb/libredb-studio-rancher-extension -b e2e -n -f "$pkg"

chart="charts/${pkg}/${version}"
endpoint="${repo_url}/extensions/${pkg}/${version}"
ENDPOINT="$endpoint" yq -i '.plugin.endpoint = strenv(ENDPOINT) | .plugin.compressedEndpoint = strenv(ENDPOINT) + ".tgz"' "$chart/values.yaml"

mkdir -p "$out/assets/${pkg}"
helm package "$chart" -d "$out/assets/${pkg}" >/dev/null
cp -R extensions "$out/extensions"
helm repo index "$out/assets" --url assets/
mv "$out/assets/index.yaml" "$out/index.yaml"

echo "Helm repository for ${pkg} ${version} in $out, plugin endpoint $endpoint"
