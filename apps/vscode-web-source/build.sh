#!/usr/bin/env bash
# Reproduce the microsoft/vscode "for web" build + serve, from source.
# Verified 2026-06-15 on Ubuntu 24, building vscode 1.125.0. Build dir is OUTSIDE
# this repo (~8.4 GB): /home/clawd/obus/vscode-build
set -euo pipefail
BUILD=/home/clawd/obus/vscode-build
# 1) Node 24.15.0+ REQUIRED (.nvmrc; preinstall rejects 24.14 and npm>=12). Local, rootless:
[ -d "$HOME/node-v24.15.0-linux-x64" ] || { cd ~ && curl -fsSLO https://nodejs.org/dist/v24.15.0/node-v24.15.0-linux-x64.tar.xz && tar xf node-v24.15.0-linux-x64.tar.xz; }
export PATH="$HOME/node-v24.15.0-linux-x64/bin:$PATH"
# 2) native deps: sudo apt-get install -y build-essential pkg-config python3 libx11-dev libxkbfile-dev libsecret-1-dev libkrb5-dev
# 3) clone + install + compile + serve
[ -d "$BUILD/.git" ] || git clone --depth 1 https://github.com/microsoft/vscode.git "$BUILD"
cd "$BUILD"
npm install                       # ~5 min, builds native modules
npm run watch &                   # compile; wait for "Finished compilation" (~2 min)
# NOTE: port 8080 is taken by this VM's Caddy — use another port.
./scripts/code-web.sh --host 127.0.0.1 --port 9888 --browser none   # serves real VS Code web
# open http://127.0.0.1:9888/  (headful)
