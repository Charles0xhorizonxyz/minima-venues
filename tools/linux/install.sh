#!/usr/bin/env bash
# Install or update Minima Venues on an Ubuntu or Debian server. Run as root by the laptop's app over SSH, from the
# folder the app was uploaded to (default /tmp/mv-up). An update replaces the program only: data/, the key store and the
# node's files are kept. Each line "STEP ..." is shown on the laptop as it happens; "DONE <version>" or "FAIL <why>" ends.
set -euo pipefail
SRC="${1:-/tmp/mv-up}"
APP=/opt/minima-venues
HOME_DIR=/var/lib/minima-venues
NODE_V=v22.11.0
say() { echo "STEP $*"; }
fail() { echo "FAIL $*"; exit 2; }

[ "$(id -u)" = 0 ] || fail "The installer must run as root."
. /etc/os-release
case "${ID:-}" in ubuntu|debian) ;; *) fail "This installer supports Ubuntu and Debian (this server is ${PRETTY_NAME:-unknown})." ;; esac
case "$(uname -m)" in x86_64) ARCH=x64 ;; aarch64) ARCH=arm64 ;; *) fail "Unsupported processor: $(uname -m)." ;; esac
command -v systemctl >/dev/null || fail "systemd is needed to keep the app running."

if ! command -v java >/dev/null || ! command -v curl >/dev/null || ! command -v xz >/dev/null; then
  say "Installing Java 17 and tools (apt)"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl xz-utils openjdk-17-jre-headless >/dev/null
fi

if [ "$(/usr/local/bin/node --version 2>/dev/null || true)" != "$NODE_V" ]; then
  say "Installing Node.js $NODE_V (checked against nodejs.org's SHA-256 list)"
  T=$(mktemp -d); F="node-$NODE_V-linux-$ARCH.tar.xz"
  curl -fsSL -o "$T/$F" "https://nodejs.org/dist/$NODE_V/$F"
  curl -fsSL -o "$T/SUMS" "https://nodejs.org/dist/$NODE_V/SHASUMS256.txt"
  (cd "$T" && grep " $F\$" SUMS | sha256sum -c - >/dev/null) || fail "The Node.js download did not match its checksum: nothing was changed."
  rm -rf "/opt/node-$NODE_V"; mkdir -p "/opt/node-$NODE_V"
  tar -xJf "$T/$F" -C "/opt/node-$NODE_V" --strip-components=1
  ln -sf "/opt/node-$NODE_V/bin/node" /usr/local/bin/node
  rm -rf "$T"
fi

if ! id venues >/dev/null 2>&1; then
  say "Creating the system user venues (no login)"
  useradd --system --create-home --home-dir "$HOME_DIR" --shell /usr/sbin/nologin venues
fi

say "Copying the app to $APP (data, keys and node files kept)"
mkdir -p "$APP/data"
for d in tools dashboard vendor; do rm -rf "${APP:?}/$d"; cp -r "$SRC/$d" "$APP/$d"; done
for f in LICENSE README.md VERSION; do [ -f "$SRC/$f" ] && cp "$SRC/$f" "$APP/$f"; done
chown -R venues:venues "$APP"

if [ -f "$SRC/minima.jar" ]; then
  say "Placing minima.jar for the node"
  mkdir -p "$HOME_DIR/Minima"; chown venues:venues "$HOME_DIR/Minima"
  install -o venues -g venues -m 644 "$SRC/minima.jar" "$HOME_DIR/Minima/minima.jar"
fi

say "Setting up the service (starts at boot, restarts if it stops)"
sed -e "s#^User=.*#User=venues#" -e "s#^WorkingDirectory=.*#WorkingDirectory=$APP#" \
    -e "s#/opt/minima-venues/data/server.log#$APP/data/server.log#g" \
    "$SRC/tools/linux/minima-venues.service" > /etc/systemd/system/minima-venues.service
systemctl daemon-reload
systemctl enable minima-venues >/dev/null 2>&1
systemctl restart minima-venues

say "Waiting for the app to answer"
for _ in $(seq 1 40); do
  if curl -fs -o /dev/null http://127.0.0.1:8765/; then
    rm -rf "$SRC"
    echo "DONE $(cat "$APP/VERSION" 2>/dev/null || echo unknown)"
    exit 0
  fi
  sleep 1
done
fail "The app did not answer after starting. Its log: $APP/data/server.log"
