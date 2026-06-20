#!/usr/bin/env bash
set -euo pipefail

repo_url="${PI_CLIENT_REPO_URL:-https://github.com/Averyyy/pi-client.git}"
repo_dir="${PI_CLIENT_REPO_DIR:-$HOME/pi-client}"
node_version="${PI_CLIENT_NODE_VERSION:-22.19.0}"
server_url="${PI_SERVER_URL:-https://pi.yreva.asia}"

if [ -z "${PI_SERVER_AUTH_TOKEN:-}" ]; then
	printf "PI_SERVER_AUTH_TOKEN is required.\n" >&2
	printf "Run: PI_SERVER_AUTH_TOKEN=your-token %s [pi-client args]\n" "$0" >&2
	exit 1
fi

if [ -s "$HOME/.nvm/nvm.sh" ]; then
	# shellcheck disable=SC1091
	. "$HOME/.nvm/nvm.sh"
else
	printf "nvm is required: %s\n" "$HOME/.nvm/nvm.sh" >&2
	exit 1
fi

nvm install "$node_version"
nvm use "$node_version"

if [ -d "$repo_dir/.git" ]; then
	git -C "$repo_dir" pull --ff-only
else
	parent_dir="$(dirname "$repo_dir")"
	mkdir -p "$parent_dir"
	git clone "$repo_url" "$repo_dir"
fi

cd "$repo_dir"

npm install --ignore-scripts
npm run build
npm run install:pi-client

export PI_SERVER_URL="$server_url"
export PI_CLIENT_MAX_REQUEST_KB="${PI_CLIENT_MAX_REQUEST_KB:-64}"

exec pi-client "$@"
