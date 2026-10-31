#!/usr/bin/env bash
set -e

REPO_URL="https://github.com/shostwp-byte/nas-sync.git"
BRANCH="main"

echo "================================================================"
echo "  NAS-SYNC — CẬP NHẬT HỆ THỐNG TỪ GITHUB ($REPO_URL)"
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

# 2. Kéo mã nguồn mới nhất từ GitHub (hỗ trợ cả thư mục cài từ Git lẫn cài từ file ZIP)
if [ -d .git ]; then
  echo "🔄 Đang kéo bản cập nhật mới nhất qua git pull..."
  git fetch origin "$BRANCH"
  git reset --hard "origin/$BRANCH"
else
  echo "🔄 Thư mục hiện tại được cài từ gói ZIP — Đang tải tarball mới nhất từ GitHub..."
  TMP_UPDATE=$(mktemp -d)
  curl -fsSL "https://codeload.github.com/shostwp-byte/nas-sync/tar.gz/refs/heads/$BRANCH" | tar -xz --strip-components=1 -C "$TMP_UPDATE"
  # Bảo toàn file .env, app_data và ssh_keys hiện có của người dùng
  rm -rf "$TMP_UPDATE/app_data" "$TMP_UPDATE/ssh_keys" "$TMP_UPDATE/.env"
  cp -rf "$TMP_UPDATE"/. ./
  rm -rf "$TMP_UPDATE"
fi

# Dọn bản live_release cũ để ưu tiên Docker Image mới vừa build
rm -rf ./app_data/live_release/current

# 3. Build lại Docker Image và khởi động không gián đoạn dữ liệu
echo "🚀 Đang biên dịch lại Docker Image & khởi động dịch vụ NAS-Sync..."
$COMPOSE_CMD up -d --build

echo ""
echo "✅ CẬP NHẬT HOÀN TẤT! Phiên bản mới nhất từ $REPO_URL đã sẵn sàng hoạt động."

