#!/usr/bin/env bash
set -euo pipefail

echo "======================================================================"
echo "  TRÌNH CÀI ĐẶT TỰ ĐỘNG ĐA NỀN TẢNG NAS-SYNC (MULTI-NAS & DOCKER)"
echo "  GitHub: https://github.com/shostwp-byte/nas-sync (MIT License)"
echo "======================================================================"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 1. Tự động dò tìm đường dẫn Docker trên mọi dòng thiết bị NAS & Linux
EXTRA_DOCKER_PATHS=(
  "/usr/local/bin"
  "/share/CACHEDEV1_DATA/.qpkg/container-station/bin"
  "/share/CACHEDEV2_DATA/.qpkg/container-station/bin"
  "/usr/local/AppCentral/docker-ce/bin"
  "/opt/bin"
)
for p in "${EXTRA_DOCKER_PATHS[@]}"; do
  if [ -d "$p" ]; then
    export PATH="$p:$PATH"
  fi
done

if ! command -v docker >/dev/null 2>&1; then
  echo "[LỖI] Không tìm thấy Docker trên hệ thống!"
  echo "      Hãy bật ứng dụng Docker / Container Station / Portainer / Docker Engine trên thiết bị NAS của bạn trước khi chạy trình cài đặt."
  exit 1
fi

# 2. Tự động nhận diện nền tảng NAS & gợi ý đường dẫn phân vùng sao lưu mặc định
NAS_PLATFORM="Generic Linux / Docker Host"
SUGGESTED_VOL1="/opt/nas-sync/backups"

if [ -f /etc/truenas-version ] || grep -qi "truenas" /etc/version 2>/dev/null; then
  NAS_PLATFORM="TrueNAS SCALE"
  FIRST_POOL="$(find /mnt -mindepth 1 -maxdepth 1 -type d ! -name 'md_size' 2>/dev/null | sort | head -n 1 || true)"
  if [ -n "$FIRST_POOL" ]; then
    SUGGESTED_VOL1="${FIRST_POOL}/vps_backups"
  fi
elif [ -f /etc/config/uLinux.conf ]; then
  NAS_PLATFORM="QNAP NAS (QTS / QuTS hero)"
  if [ -d /share/CACHEDEV1_DATA ]; then
    SUGGESTED_VOL1="/share/CACHEDEV1_DATA/VPS_Backups"
  elif [ -d /share/ZFS1_DATA ]; then
    SUGGESTED_VOL1="/share/ZFS1_DATA/VPS_Backups"
  fi
elif [ -f /etc/unraid-version ]; then
  NAS_PLATFORM="Unraid OS"
  if [ -d /mnt/cache ]; then
    SUGGESTED_VOL1="/mnt/cache/vps_backups"
  elif [ -d /mnt/user ]; then
    SUGGESTED_VOL1="/mnt/user/vps_backups"
  fi
elif [ -f /etc/ugreen-nas ] || [ -d /ugreen ]; then
  NAS_PLATFORM="UGREEN NASync (UGOS Pro)"
  if [ -d /volume1 ]; then
    SUGGESTED_VOL1="/volume1/VPS_Backups"
  fi
elif [ -d /usr/local/AppCentral ]; then
  NAS_PLATFORM="Asustor NAS (ADM)"
  if [ -d /volume1 ]; then
    SUGGESTED_VOL1="/volume1/VPS_Backups"
  fi
elif [ -d /Volume1 ]; then
  NAS_PLATFORM="TerraMaster NAS (TOS)"
  SUGGESTED_VOL1="/Volume1/VPS_Backups"
elif [ -d /volume1 ]; then
  NAS_PLATFORM="NAS Storage (/volume1)"
  SUGGESTED_VOL1="/volume1/VPS_Backups"
elif compgen -G "/srv/dev-disk-by-*" >/dev/null 2>&1; then
  NAS_PLATFORM="OpenMediaVault (OMV)"
  FIRST_OMV_DISK="$(compgen -G "/srv/dev-disk-by-*" | sort | head -n 1)"
  SUGGESTED_VOL1="${FIRST_OMV_DISK}/vps_backups"
fi

echo "[1/5] Môi trường phát hiện: ${NAS_PLATFORM}"
echo "      Phiên bản Docker:     $(docker --version)"

# 3. Tạo cấu trúc thư mục nội bộ dự án & gán quyền bảo mật cho SSH Keys
mkdir -p ./app_data ./ssh_keys
chmod 700 ./ssh_keys
echo "[2/5] Đã khởi tạo thư mục dữ liệu ./app_data và ./ssh_keys"

# 4. Khởi tạo file .env nếu chưa tồn tại hoặc vẫn còn nguyên bản mẫu .env.example chưa cấu hình (U11 Fix)
NEEDS_ENV_INIT=0
if [ ! -f ./.env ]; then
  NEEDS_ENV_INIT=1
elif [ -f ./.env.example ] && cmp -s ./.env ./.env.example; then
  NEEDS_ENV_INIT=1
elif grep -Eq '^SANDBOX_DB_PASSWORD=sandbox_secret_pass\r?$' ./.env 2>/dev/null; then
  NEEDS_ENV_INIT=1
fi

if [ "$NEEDS_ENV_INIT" = "1" ]; then
  cp ./.env.example ./.env
  RAND_JWT="$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  RAND_TOTP="$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  RAND_DB="$(openssl rand -hex 16 2>/dev/null || head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  sed -i "s|^JWT_SECRET=.*|JWT_SECRET=${RAND_JWT}|" ./.env
  sed -i "s|^TOTP_ENCRYPTION_KEY=.*|TOTP_ENCRYPTION_KEY=${RAND_TOTP}|" ./.env
  sed -i "s|^SANDBOX_DB_PASSWORD=.*|SANDBOX_DB_PASSWORD=${RAND_DB}|" ./.env
  sed -i "s|^NAS_VOL1_PATH=.*|NAS_VOL1_PATH=${SUGGESTED_VOL1}|" ./.env

  if [ -n "${SUDO_UID:-}" ] && [ "${SUDO_UID}" != "0" ]; then
    sed -i "s|^PUID=.*|PUID=${SUDO_UID}|" ./.env
    sed -i "s|^PGID=.*|PGID=${SUDO_GID:-1000}|" ./.env
  fi

  echo "[3/5] Đã khởi tạo file .env với khóa mật mã ngẫu nhiên và phân vùng lưu trữ tối ưu."
else
  echo "[3/5] Giữ nguyên file .env đã tùy biến hiện có."
fi

VOL1_PATH=$(grep -E '^NAS_VOL1_PATH=' ./.env | cut -d= -f2- | tr -d '\r"' || echo "$SUGGESTED_VOL1")
TARGET_PUID=$(grep -E '^PUID=' ./.env | cut -d= -f2- | tr -d '\r"' || echo "1000")
TARGET_PGID=$(grep -E '^PGID=' ./.env | cut -d= -f2- | tr -d '\r"' || echo "1000")

mkdir -p "$VOL1_PATH"
chown "${TARGET_PUID}:${TARGET_PGID}" "$VOL1_PATH" ./app_data ./ssh_keys 2>/dev/null || true

echo "[4/5] Đã sẵn sàng phân vùng lưu trữ Backup:"
echo "      - Host Path: $VOL1_PATH -> Container: /mnt/vol1 (PUID:PGID = ${TARGET_PUID}:${TARGET_PGID})"

# 5. Build và khởi chạy cụm Container bằng Docker Compose
echo "[5/5] Đang biên dịch Docker Image & khởi chạy hệ thống (vui lòng đợi 1 - 3 phút ở lần đầu)..."
if docker compose version >/dev/null 2>&1; then
  docker compose up -d --build
elif command -v docker-compose >/dev/null 2>&1; then
  docker-compose up -d --build
else
  echo "[LỖI] Không tìm thấy plugin 'docker compose' hoặc 'docker-compose'."
  exit 1
fi

HOST_PORT=$(grep -E '^APP_HOST_PORT=' ./.env | cut -d= -f2- | tr -d '\r"' || echo "3080")
NAS_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "IP-NAS-CUA-BAN")

echo ""
echo "======================================================================"
echo "  CÀI ĐẶT NAS-SYNC HOÀN TẤT 100%!"
echo "  - Nền tảng lưu trữ:   ${NAS_PLATFORM}"
echo "  - Truy cập nội bộ:    http://${NAS_IP}:${HOST_PORT}"
echo "  - Tài khoản mặc định: admin / nas-sync@2026 (Đổi mật khẩu ngay tại mục Cấu hình)"
echo "  - Cập nhật về sau:    Bấm nút '1-Click Update' trên Web UI hoặc chạy ./update.sh"
echo "======================================================================"
