#!/usr/bin/env bash
# ==============================================================================
# Obscura Browser Engine Downloader & Installer for NEXA
# Supports macOS (Apple Silicon & Intel) and Linux (x86_64 & ARM64)
# ==============================================================================

set -euo pipefail

OBSCURA_VERSION="${OBSCURA_VERSION:-v0.2.5}"
INSTALL_DIR="${OBSCURA_INSTALL_DIR:-$HOME/.obscura/bin}"

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$ARCH" in
  x86_64|amd64)
    ARCH_NAME="x86_64"
    ;;
  arm64|aarch64)
    ARCH_NAME="aarch64"
    ;;
  *)
    echo "[-] Unsupported architecture: $ARCH"
    exit 1
    ;;
esac

case "$OS" in
  darwin)
    PLATFORM="macos"
    ;;
  linux)
    PLATFORM="linux"
    ;;
  *)
    echo "[-] Unsupported operating system: $OS"
    exit 1
    ;;
esac

ASSET_NAME="obscura-${ARCH_NAME}-${PLATFORM}.tar.gz"
DOWNLOAD_URL="https://github.com/h4ckf0r0day/obscura/releases/download/${OBSCURA_VERSION}/${ASSET_NAME}"

echo "[+] Target platform: ${PLATFORM} (${ARCH_NAME})"
echo "[+] Obscura release: ${OBSCURA_VERSION}"
echo "[+] Install destination: ${INSTALL_DIR}"

mkdir -p "$INSTALL_DIR"
TEMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

echo "[+] Downloading ${DOWNLOAD_URL}..."
curl -sSL "$DOWNLOAD_URL" -o "${TEMP_DIR}/${ASSET_NAME}"

echo "[+] Extracting binaries..."
tar -xzf "${TEMP_DIR}/${ASSET_NAME}" -C "$TEMP_DIR"

if [ -f "${TEMP_DIR}/obscura" ]; then
  mv "${TEMP_DIR}/obscura" "$INSTALL_DIR/"
  chmod +x "$INSTALL_DIR/obscura"
fi

if [ -f "${TEMP_DIR}/obscura-worker" ]; then
  mv "${TEMP_DIR}/obscura-worker" "$INSTALL_DIR/"
  chmod +x "$INSTALL_DIR/obscura-worker"
fi

echo "[+] Obscura installed successfully at ${INSTALL_DIR}/obscura"
"$INSTALL_DIR/obscura" --version
