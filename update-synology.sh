#!/usr/bin/env bash
set -euo pipefail

REPO_OWNER="${GITHUB_REPO_OWNER:-shostwp-byte}"
REPO_NAME="${GITHUB_REPO_NAME:-nas-sync}"
REPO_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}.git"
DEV_MAIN_MODE="false"

if [ "${1:-}" = "--dev-main" ]; then
  DEV_MAIN_MODE="true"
fi

echo "================================================================"
echo "  NAS-SYNC — CẬP NHẬT HỆ THỐNG TỪ GITHUB RELEASES ($REPO_URL)"
echo "================================================================"

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD="docker-compose"
else
  echo "[LỖI] Không tìm thấy Docker Compose. Vui lòng bật Container Manager trên Synology DSM."
  exit 1
fi

# 1. Sao lưu an toàn CSDL SQLite hiện tại
mkdir -p ./app_data/db_backups
STAMP=$(date +%Y%m%d_%H%M%S)
for dbf in ./app_data/*.db; do
  if [ -f "$dbf" ]; then
    cp -f "$dbf" "./app_data/db_backups/$(basename "$dbf").bak_$STAMP"
    echo "✅ Đã sao lưu an toàn CSDL tại ./app_data/db_backups/$(basename "$dbf").bak_$STAMP"
  fi
done

# R2 Fix: Mặc định chỉ cập nhật theo tag Release chính thức (trừ khi truyền --dev-main tường minh)
# và KHÔNG BAO GIỜ ghi đè docker-compose.yml / .env người dùng đã tùy chỉnh.
TMP_UPDATE=$(mktemp -d)
trap 'rm -rf "${TMP_UPDATE:-}"' EXIT

if [ "$DEV_MAIN_MODE" = "true" ]; then
  echo "⚠️  [DEV MODE] Đang kéo mã nguồn nhánh main theo yêu cầu tường minh (--dev-main)..."
  curl -fsSL "https://codeload.github.com/${REPO_OWNER}/${REPO_NAME}/tar.gz/refs/heads/main" | tar -xz --strip-components=1 -C "$TMP_UPDATE"
  TARGET_LABEL="dev-main"
else
  echo "🔍 Đang truy vấn phiên bản Release chính thức mới nhất từ GitHub..."
  REL_JSON=$(curl -fsSL "https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest")
  LATEST_TAG=$(printf '%s' "$REL_JSON" | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')
  if [ -z "$LATEST_TAG" ]; then
    echo "[LỖI] Không tìm thấy bản phát hành (Release tag) hợp lệ trên GitHub."
    exit 1
  fi
  echo "📦 Đang tải gói phát hành chính thức ${LATEST_TAG}..."
  RELEASE_ASSET_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/${LATEST_TAG}/nas-sync-synology.tar.gz"
  if curl -fsSL "$RELEASE_ASSET_URL" -o "$TMP_UPDATE/bundle.tar.gz" 2>/dev/null; then
    tar -xzf "$TMP_UPDATE/bundle.tar.gz" --strip-components=1 -C "$TMP_UPDATE"
    rm -f "$TMP_UPDATE/bundle.tar.gz"
  else
    curl -fsSL "https://codeload.github.com/${REPO_OWNER}/${REPO_NAME}/tar.gz/refs/tags/${LATEST_TAG}" | tar -xz --strip-components=1 -C "$TMP_UPDATE"
  fi
  TARGET_LABEL="$LATEST_TAG"
fi

# Bảo toàn tuyệt đối dữ liệu vận hành & cấu hình tùy biến của quản trị viên trên NAS
rm -rf "$TMP_UPDATE/app_data" "$TMP_UPDATE/ssh_keys" "$TMP_UPDATE/.env"

if [ -f "./docker-compose.yml" ] && [ -f "$TMP_UPDATE/docker-compose.yml" ]; then
  if ! cmp -s "./docker-compose.yml" "$TMP_UPDATE/docker-compose.yml"; then
    cp -f "$TMP_UPDATE/docker-compose.yml" "./docker-compose.yml.dist"
    echo "ℹ️  Đã giữ nguyên ./docker-compose.yml hiện tại của bạn (mẫu mới lưu tại ./docker-compose.yml.dist)."
  fi
  rm -f "$TMP_UPDATE/docker-compose.yml"
fi

cp -rf "$TMP_UPDATE"/. ./
rm -rf "$TMP_UPDATE"
trap - EXIT

# Dọn bản live_release cũ để ưu tiên Docker Image mới vừa build
rm -rf ./app_data/live_release/current

# 3. Build lại Docker Image và khởi động không gián đoạn dữ liệu
echo "🚀 Đang biên dịch lại Docker Image (${TARGET_LABEL}) & khởi động dịch vụ NAS-Sync..."
$COMPOSE_CMD up -d --build

echo ""
echo "✅ CẬP NHẬT HOÀN TẤT! Phiên bản ${TARGET_LABEL} từ $REPO_URL đã sẵn sàng hoạt động."
