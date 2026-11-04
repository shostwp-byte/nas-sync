#!/usr/bin/env bash
if [ -z "${BASH_VERSION:-}" ] && command -v bash >/dev/null 2>&1; then
  exec bash "$0" "$@"
fi
set -eu
if (set -o pipefail) 2>/dev/null; then
  set -o pipefail
fi

main() {
REPO_OWNER="${GITHUB_REPO_OWNER:-shostwp-byte}"
REPO_NAME="${GITHUB_REPO_NAME:-nas-sync}"
REPO_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}.git"
DEV_MAIN_MODE="false"

# U9 Security Fix: Khóa công khai Ed25519 chính thức nhúng cứng để xác thực gói nas-sync-bundle.tar.gz trước khi build/chạy trên host
DEFAULT_PUBKEY_PEM="-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEApSztKo5UUyVAV5hfAmATSIyCR6Teo3PDUEkE4HXi30Q=
-----END PUBLIC KEY-----"
ACTIVE_PUBKEY_PEM="${NAS_SYNC_RELEASE_PUBLIC_KEY_PEM:-$DEFAULT_PUBKEY_PEM}"

if [ "${1:-}" = "--dev-main" ]; then
  DEV_MAIN_MODE="true"
fi

echo "================================================================"
echo "  NAS-SYNC — CẬP NHẬT HỆ THỐNG TỪ GITHUB RELEASES ($REPO_URL)"
echo "================================================================"

for p in \
  "/usr/local/bin" \
  "/share/CACHEDEV1_DATA/.qpkg/container-station/bin" \
  "/share/CACHEDEV2_DATA/.qpkg/container-station/bin" \
  "/usr/local/AppCentral/docker-ce/bin" \
  "/opt/bin"; do
  if [ -d "$p" ]; then
    export PATH="$p:$PATH"
  fi
done

if [ "${NAS_SYNC_UPDATE_VERIFY_ONLY:-0}" != "1" ]; then
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    COMPOSE_CMD="docker compose"
  elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE_CMD="docker-compose"
  else
    echo "[LỖI] Không tìm thấy Docker Compose trên thiết bị NAS/Linux."
    exit 1
  fi
fi

verify_ed25519_bundle_signature() {
  local clean_tag="$1"
  local actual_sha="$2"
  local sig_file="$3"
  local work_dir="$4"

  local sig_b64
  sig_b64=$(awk 'NF{print $1; exit}' "$sig_file" | tr -d '\r\n ')
  if [ -z "$sig_b64" ]; then
    return 1
  fi

  local payload_str="nas-sync-bundle-v1|${clean_tag}|${actual_sha}"
  local node_verify_js='
    try {
      var crypto = require("crypto");
      if (typeof crypto.verify !== "function" || typeof crypto.createPublicKey !== "function") {
        process.exit(20);
      }
      var pubPem = String(process.env.NAS_PUB_PEM || "").replace(/\\n/g, "\n").trim();
      var payload = Buffer.from(String(process.env.NAS_PAYLOAD || ""), "utf8");
      var sigB64 = String(process.env.NAS_SIG_B64 || "").trim();
      if (!/^[A-Za-z0-9+/=]+$/.test(sigB64)) process.exit(10);
      var sig = Buffer.from(sigB64, "base64");
      if (sig.length !== 64) process.exit(10);
      var pubKey = crypto.createPublicKey(pubPem);
      var ok = crypto.verify(null, payload, pubKey, sig);
      process.exit(ok ? 0 : 10);
    } catch (e) {
      process.exit(20);
    }
  '
  local rc=0

  # 1. Thử bằng Node.js trên host (tương thích Node >= 12 không cần tiền tố node:crypto; nếu Node quá cũ trả mã 20 để chuyển tiếp)
  if command -v node >/dev/null 2>&1; then
    rc=0
    NAS_PUB_PEM="$ACTIVE_PUBKEY_PEM" NAS_PAYLOAD="$payload_str" NAS_SIG_B64="$sig_b64" node -e "$node_verify_js" 2>/dev/null || rc=$?
    if [ "$rc" -eq 0 ]; then
      return 0
    elif [ "$rc" -eq 10 ]; then
      return 1
    fi
  fi

  # 2. Thử trực tiếp qua Node.js hiện đại bên trong container nas_sync_core đang chạy (tức thì, không phụ thuộc gói trên host NAS)
  if command -v docker >/dev/null 2>&1 && [ "$(docker inspect -f '{{.State.Running}}' nas_sync_core 2>/dev/null || true)" = "true" ]; then
    rc=0
    docker exec \
      -e NAS_PUB_PEM="$ACTIVE_PUBKEY_PEM" \
      -e NAS_PAYLOAD="$payload_str" \
      -e NAS_SIG_B64="$sig_b64" \
      nas_sync_core node -e "$node_verify_js" 2>/dev/null || rc=$?
    if [ "$rc" -eq 0 ]; then
      return 0
    elif [ "$rc" -eq 10 ]; then
      return 1
    fi
  fi

  # 3. Thử bằng OpenSSL trên host nếu hỗ trợ đầy đủ cả khóa Ed25519 lẫn cờ -rawin (tránh báo sai trên OpenSSL 1.0.2/1.1.1 cũ của NAS)
  if command -v openssl >/dev/null 2>&1 && openssl pkeyutl -help 2>&1 | grep -q -- '-rawin'; then
    printf '%s\n' "$ACTIVE_PUBKEY_PEM" > "$work_dir/pubkey.pem"
    printf '%s' "$payload_str" > "$work_dir/payload.bin"
    if openssl pkey -pubin -in "$work_dir/pubkey.pem" -noout >/dev/null 2>&1 && \
       printf '%s' "$sig_b64" | openssl base64 -d -A -out "$work_dir/sig.bin" 2>/dev/null; then
      if openssl pkeyutl -verify -pubin -inkey "$work_dir/pubkey.pem" -rawin -in "$work_dir/payload.bin" -sigfile "$work_dir/sig.bin" >/dev/null 2>&1; then
        return 0
      fi
      return 1
    fi
  fi

  # 4. Dự phòng cô lập mạng bằng image node:24-alpine chuẩn
  if command -v docker >/dev/null 2>&1; then
    rc=0
    docker run --rm --network none \
      -e NAS_PUB_PEM="$ACTIVE_PUBKEY_PEM" \
      -e NAS_PAYLOAD="$payload_str" \
      -e NAS_SIG_B64="$sig_b64" \
      node:24-alpine node -e "$node_verify_js" 2>/dev/null || rc=$?
    if [ "$rc" -eq 0 ]; then
      return 0
    fi
    return 1
  fi

  return 1
}

# 1. Sao lưu an toàn CSDL SQLite hiện tại
mkdir -p ./app_data/db_backups
STAMP=$(date +%Y%m%d_%H%M%S)
for dbf in ./app_data/*.db; do
  if [ -f "$dbf" ]; then
    cp -f "$dbf" "./app_data/db_backups/$(basename "$dbf").bak_$STAMP"
    echo "✅ Đã sao lưu an toàn CSDL tại ./app_data/db_backups/$(basename "$dbf").bak_$STAMP"
  fi
done

# 2. Mặc định CHỈ cập nhật theo gói Release đã ký Ed25519 + SHA-256 (Fail-Closed — U9 Fix)
TMP_UPDATE=$(mktemp -d)
trap 'rm -rf "${TMP_UPDATE:-}"' EXIT

if [ "$DEV_MAIN_MODE" = "true" ]; then
  echo "⚠️  [DEV MODE] Đang kéo mã nguồn nhánh main theo yêu cầu tường minh (--dev-main)..."
  curl -fsSL "https://codeload.github.com/${REPO_OWNER}/${REPO_NAME}/tar.gz/refs/heads/main" | tar -xz --strip-components=1 -C "$TMP_UPDATE"
  TARGET_LABEL="dev-main"
else
  if [ -n "${NAS_SYNC_RELEASE_BASE_URL_OVERRIDE:-}" ] && [ -n "${NAS_SYNC_RELEASE_TAG_OVERRIDE:-}" ]; then
    LATEST_TAG="$NAS_SYNC_RELEASE_TAG_OVERRIDE"
    DOWNLOAD_BASE="${NAS_SYNC_RELEASE_BASE_URL_OVERRIDE%/}"
  else
    echo "🔍 Đang truy vấn phiên bản Release chính thức mới nhất từ GitHub..."
    REL_JSON=$(curl -fsSL "https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest")
    LATEST_TAG=$(printf '%s' "$REL_JSON" | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')
    DOWNLOAD_BASE="https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/${LATEST_TAG}"
  fi

  CLEAN_TAG="${LATEST_TAG#refs/tags/}"
  CLEAN_TAG="${CLEAN_TAG#v}"
  if [ -z "$CLEAN_TAG" ] || ! printf '%s' "$CLEAN_TAG" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
    echo "[LỖI] Tag phiên bản phát hành không hợp lệ: '${LATEST_TAG}'. Đã hủy cập nhật."
    exit 1
  fi

  echo "📦 Đang tải gói phát hành chính thức ${LATEST_TAG} kèm chữ ký số Ed25519..."
  BUNDLE_URL="${DOWNLOAD_BASE}/nas-sync-bundle.tar.gz"
  BUNDLE_SHA_URL="${BUNDLE_URL}.sha256"
  BUNDLE_SIG_URL="${BUNDLE_URL}.sig"

  if ! curl -fsSL "$BUNDLE_URL" -o "$TMP_UPDATE/bundle.tar.gz" || [ ! -s "$TMP_UPDATE/bundle.tar.gz" ]; then
    echo "[LỖI] Không thể tải xuống gói phát hành nas-sync-bundle.tar.gz (không fallback sang codeload chưa ký). Đã hủy cập nhật."
    exit 1
  fi
  if ! curl -fsSL "$BUNDLE_SHA_URL" -o "$TMP_UPDATE/bundle.tar.gz.sha256" || [ ! -s "$TMP_UPDATE/bundle.tar.gz.sha256" ]; then
    echo "[LỖI] Thiếu hoặc không thể tải tệp checksum nas-sync-bundle.tar.gz.sha256! Đã hủy cập nhật (Fail-Closed)."
    exit 1
  fi
  if ! curl -fsSL "$BUNDLE_SIG_URL" -o "$TMP_UPDATE/bundle.tar.gz.sig" || [ ! -s "$TMP_UPDATE/bundle.tar.gz.sig" ]; then
    echo "[LỖI] Thiếu hoặc không thể tải chữ ký số Ed25519 nas-sync-bundle.tar.gz.sig! Đã hủy cập nhật (Fail-Closed)."
    exit 1
  fi

  EXPECTED_SHA=$(awk 'NF{print tolower($1); exit}' "$TMP_UPDATE/bundle.tar.gz.sha256" | tr -d '\r\n ')
  if ! printf '%s' "$EXPECTED_SHA" | grep -Eq '^[0-9a-f]{64}$'; then
    echo "[LỖI] Định dạng SHA-256 trong tệp .sha256 không hợp lệ! Đã hủy cập nhật."
    exit 1
  fi

  ACTUAL_SHA=""
  if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL_SHA=$(sha256sum "$TMP_UPDATE/bundle.tar.gz" 2>/dev/null | awk '{print tolower($1)}' || true)
  fi
  if [ -z "$ACTUAL_SHA" ] && command -v shasum >/dev/null 2>&1; then
    ACTUAL_SHA=$(shasum -a 256 "$TMP_UPDATE/bundle.tar.gz" 2>/dev/null | awk '{print tolower($1)}' || true)
  fi
  if [ -z "$ACTUAL_SHA" ] && command -v openssl >/dev/null 2>&1; then
    ACTUAL_SHA=$(openssl dgst -sha256 "$TMP_UPDATE/bundle.tar.gz" 2>/dev/null | awk '{print tolower($NF)}' || true)
  fi
  if [ -z "$ACTUAL_SHA" ] && command -v node >/dev/null 2>&1; then
    ACTUAL_SHA=$(node -e 'var fs=require("fs"),crypto=require("crypto");process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"));' "$TMP_UPDATE/bundle.tar.gz" 2>/dev/null || true)
  fi
  if [ -z "$ACTUAL_SHA" ]; then
    echo "[LỖI] Không tìm thấy công cụ tính băm SHA-256 (sha256sum / shasum / openssl / node). Đã hủy cập nhật."
    exit 1
  fi

  if [ "$EXPECTED_SHA" != "$ACTUAL_SHA" ]; then
    echo "[LỖI] Sai lệch mã băm SHA-256 của gói cập nhật (mong đợi ${EXPECTED_SHA}, nhận được ${ACTUAL_SHA})! Đã hủy cập nhật."
    exit 1
  fi

  if ! verify_ed25519_bundle_signature "$CLEAN_TAG" "$ACTUAL_SHA" "$TMP_UPDATE/bundle.tar.gz.sig" "$TMP_UPDATE"; then
    echo "[LỖI] Xác thực chữ ký số Ed25519 của gói nas-sync-bundle.tar.gz THẤT BẠI! Đã hủy cập nhật ngay lập tức."
    exit 1
  fi

  echo "🔐 Đã xác thực thành công chữ ký số Ed25519 & mã băm SHA-256 (${ACTUAL_SHA})."
  if [ "${NAS_SYNC_UPDATE_VERIFY_ONLY:-0}" = "1" ]; then
    echo "✅ Chế độ kiểm định chữ ký hoàn tất."
    exit 0
  fi

  tar -xzf "$TMP_UPDATE/bundle.tar.gz" --strip-components=1 -C "$TMP_UPDATE"
  rm -f "$TMP_UPDATE/bundle.tar.gz" "$TMP_UPDATE/bundle.tar.gz.sha256" "$TMP_UPDATE/bundle.tar.gz.sig" \
        "$TMP_UPDATE/pubkey.pem" "$TMP_UPDATE/payload.bin" "$TMP_UPDATE/sig.bin"
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
}

main "$@"
exit $?
