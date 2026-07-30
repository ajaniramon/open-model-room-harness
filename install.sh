#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

node_major() {
  if command -v node >/dev/null 2>&1; then
    node -p "Number(process.versions.node.split('.')[0])"
  else
    echo 0
  fi
}

major="$(node_major)"
if [ "$major" -lt 20 ]; then
  echo "Node.js 20 or newer is required. Installing the current LTS release..."
  if command -v brew >/dev/null 2>&1; then
    brew install node || brew upgrade node
  else
    if ! command -v curl >/dev/null 2>&1; then
      if command -v apt-get >/dev/null 2>&1; then
        sudo apt-get update
        sudo apt-get install -y curl
      elif command -v dnf >/dev/null 2>&1; then
        sudo dnf install -y curl
      elif command -v yum >/dev/null 2>&1; then
        sudo yum install -y curl
      elif command -v pacman >/dev/null 2>&1; then
        sudo pacman -Sy --needed curl
      else
        echo "A supported package manager or curl is required to bootstrap Node.js." >&2
        exit 1
      fi
    fi
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    mkdir -p "$NVM_DIR"
    installer="$(mktemp)"
    trap 'rm -f "$installer"' EXIT
    curl --fail --silent --show-error --location \
      https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh \
      --output "$installer"
    bash "$installer"
    # shellcheck source=/dev/null
    . "$NVM_DIR/nvm.sh"
    nvm install --lts
    nvm use --lts
  fi
  major="$(node_major)"
fi

if [ "$major" -lt 20 ]; then
  echo "Node.js installation completed but Node 20+ is still unavailable." >&2
  exit 1
fi

echo "Using Node.js $(node --version)"
echo "Installing desktop installer dependencies..."
npm install
npm run setup
