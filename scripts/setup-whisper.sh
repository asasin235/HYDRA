#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────
# setup-whisper.sh — Install whisper.cpp with Metal (Apple Silicon)
#                     and download the large-v3-q5_0 model
#
# Usage:
#   chmod +x scripts/setup-whisper.sh
#   bash scripts/setup-whisper.sh
#
# This script will:
#   1. Clone whisper.cpp into ~/whisper.cpp
#   2. Build with CMake + Metal (Apple GPU acceleration)
#   3. Download the ggml-large-v3-q5_0 quantized model
#   4. Print the paths to add to your .env
# ──────────────────────────────────────────────────────────────────
set -euo pipefail

INSTALL_DIR="${HOME}/whisper.cpp"
MODEL_DIR="${HOME}/models"
MODEL_NAME="ggml-large-v3-q5_0"

echo "══════════════════════════════════════════════════════"
echo "  whisper.cpp Setup — Apple Silicon with Metal"
echo "══════════════════════════════════════════════════════"
echo ""

# ── Prerequisites ──────────────────────────────────────────────
echo "▶ Checking prerequisites..."

if ! command -v cmake &>/dev/null; then
    echo "  ⚠️  cmake not found. Installing via Homebrew..."
    if ! command -v brew &>/dev/null; then
        echo "  ❌ Homebrew not found. Install from https://brew.sh"
        exit 1
    fi
    brew install cmake
fi

if ! command -v git &>/dev/null; then
    echo "  ❌ git not found. Install Xcode command line tools: xcode-select --install"
    exit 1
fi

echo "  ✅ Prerequisites OK"
echo ""

# ── Clone whisper.cpp ──────────────────────────────────────────
if [ -d "$INSTALL_DIR" ]; then
    echo "▶ whisper.cpp already exists at ${INSTALL_DIR}, pulling latest..."
    cd "$INSTALL_DIR"
    git pull --ff-only || echo "  ⚠️  git pull failed, continuing with existing version"
else
    echo "▶ Cloning whisper.cpp..."
    git clone https://github.com/ggerganov/whisper.cpp.git "$INSTALL_DIR"
    cd "$INSTALL_DIR"
fi
echo ""

# ── Build with Metal ───────────────────────────────────────────
echo "▶ Building whisper.cpp with Metal (Apple GPU) support..."
mkdir -p build && cd build
cmake .. \
    -DWHISPER_METAL=ON \
    -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_SHARED_LIBS=OFF

cmake --build . --config Release -j "$(sysctl -n hw.ncpu)"

WHISPER_BIN="${INSTALL_DIR}/build/bin/whisper-cli"

if [ ! -f "$WHISPER_BIN" ]; then
    # Older versions may use 'main' as the binary name
    WHISPER_BIN="${INSTALL_DIR}/build/bin/main"
fi

if [ ! -f "$WHISPER_BIN" ]; then
    echo "  ❌ Build failed — binary not found"
    echo "  Checked: ${INSTALL_DIR}/build/bin/whisper-cli"
    echo "  Checked: ${INSTALL_DIR}/build/bin/main"
    exit 1
fi

echo "  ✅ Built: ${WHISPER_BIN}"
echo ""

# ── Download Model ─────────────────────────────────────────────
echo "▶ Downloading ${MODEL_NAME} model (~1.5 GB)..."
mkdir -p "$MODEL_DIR"

cd "$INSTALL_DIR"

# Use whisper.cpp's built-in download script
if [ -f "models/download-ggml-model.sh" ]; then
    bash models/download-ggml-model.sh large-v3-q5_0
    MODEL_FILE="${INSTALL_DIR}/models/${MODEL_NAME}.bin"
elif [ -f "scripts/download-ggml-model.sh" ]; then
    bash scripts/download-ggml-model.sh large-v3-q5_0
    MODEL_FILE="${INSTALL_DIR}/models/${MODEL_NAME}.bin"
else
    # Manual download from Hugging Face
    echo "  Download script not found, downloading manually from Hugging Face..."
    MODEL_FILE="${MODEL_DIR}/${MODEL_NAME}.bin"
    if [ ! -f "$MODEL_FILE" ]; then
        curl -L --progress-bar \
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_NAME}.bin" \
            -o "$MODEL_FILE"
    else
        echo "  Model already exists at ${MODEL_FILE}"
    fi
fi

# Copy model to ~/models/ for a stable path
if [ -f "${INSTALL_DIR}/models/${MODEL_NAME}.bin" ] && [ "$MODEL_FILE" != "${MODEL_DIR}/${MODEL_NAME}.bin" ]; then
    cp "${INSTALL_DIR}/models/${MODEL_NAME}.bin" "${MODEL_DIR}/${MODEL_NAME}.bin"
    MODEL_FILE="${MODEL_DIR}/${MODEL_NAME}.bin"
fi

echo "  ✅ Model: ${MODEL_FILE}"
echo ""

# ── Summary ────────────────────────────────────────────────────
echo "══════════════════════════════════════════════════════"
echo "  ✅  Installation Complete!"
echo "══════════════════════════════════════════════════════"
echo ""
echo "  Add these to your .env file:"
echo ""
echo "  WHISPER_CPP_PATH=${WHISPER_BIN}"
echo "  WHISPER_MODEL_PATH=${MODEL_FILE}"
echo ""
echo "  Quick test:"
echo "  ${WHISPER_BIN} -m ${MODEL_FILE} -f /path/to/audio.mp3"
echo ""
echo "══════════════════════════════════════════════════════"
