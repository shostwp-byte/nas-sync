#!/usr/bin/env bash
set -euo pipefail

echo "======================================================================"
echo "  TRÌNH CÀI ĐẶT TỰ ĐỘNG NAS-SYNC TRÊN SYNOLOGY NAS"
echo "  GitHub: https://github.com/shostwp-byte/nas-sync (MIT License)"
echo "======================================================================"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 1. Tìm kiếm lệnh docker trên Synology DSM (thường nằm ở /usr/local/bin/docker)
export PATH="/usr/local/bin:$PATH"
if ! command -v docker >/dev/null 2>&1; then
  echo "[LỖI] Không tìm thấy Docker! Vui lòng mở Package Center trên Synology DSM và cài đặt 'Container Manager' trước."
  exit 1
fi

echo "[1/5] Đã phát hiện Docker: $(docker --version)"

# 2. Tạo cấu trúc thư mục nội bộ dự án & gán quyền bảo mật cho SSH Keys
mkdir -p ./app_data ./ssh_keys
chmod 700 ./ssh_keys
echo "[2/5] Đã khởi tạo thư mục dữ liệu ./app_data, ./ssh_keys"

# 3. Khởi tạo file .env nếu chưa tồn tại
if [ ! -f ./.env ]; then
  cp ./.env.example ./.env
  RAND_JWT="$(openssl rand -hex 24 2>/dev/null || head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  RAND_DB="$(openssl rand -hex 12 2>/dev/null || head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  sed -i "s|^JWT_SECRET=.*|JWT_SECRET=${RAND_JWT}|" ./.env
  sed -i "s|^SANDBOX_DB_PASSWORD=.*|SANDBOX_DB_PASSWORD=${RAND_DB}|" ./.env
  echo "[3/5] Đã tạo file .env với khóa bảo mật ngẫu nhiên."
else
  echo "[3/5] Giữ nguyên file .env hiện có."
fi

# Đọc đường dẫn Volume 1 từ .env và tự động tạo thư mục đích trên NAS
VOL1_PATH=$(grep -E '^NAS_VOL1_PATH=' ./.env | cut -d= -f2- | tr -d '\r"' || echo "/volume1/VPS_Backups")
mkdir -p "$VOL1_PATH"
echo "[4/5] Đã sẵn sàng phân vùng lưu trữ Backup:"
echo "      - Volume 1: $VOL1_PATH -> /mnt/vol1"

# 4. Build và khởi chạy cụm Container bằng Docker Compose
echo "[5/5] Đang biên dịch Docker Image & khởi chạy hệ thống (vui lòng đợi 1 - 3 phút ở lần đầu)..."
if docker compose version >/dev/null 2>&1; then
  docker compose up -d --build
elif command -v docker-compose >/dev/null 2>&1; then
  docker-compose up -d --build
else
  echo "[LỖI] Không tìm thấy plugin 'docker compose'."
  exit 1
fi

HOST_PORT=$(grep -E '^APP_HOST_PORT=' ./.env | cut -d= -f2- | tr -d '\r"' || echo "3080")
NAS_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "IP-NAS-CUA-BAN")

echo ""
echo "======================================================================"
echo "  CÀI ĐẶT NAS-SYNC HOÀN TẤT 100%!"
echo "  - Truy cập nội bộ:    http://${NAS_IP}:${HOST_PORT}"
echo "  - Tài khoản mặc định: admin / nas-sync@2026 (Đổi mật khẩu tại mục Cấu hình)"
echo "  - Cập nhật về sau:    Bấm nút '1-Click Update' trong mục Cấu hình & Cập nhật"
echo "======================================================================"
