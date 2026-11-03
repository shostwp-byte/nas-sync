#!/bin/sh
set -e

DATA_ROOT="${DATA_DIR:-/app/data}"
PERSIST_DIR="$DATA_ROOT/live_release/current"

# E1 Fix: Đồng bộ bản cập nhật bền vững nguyên tử — cài đặt npm ci vào thư mục tạm cô lập TRƯỚC khi chạm vào /app/package.json
if [ -f "$PERSIST_DIR/package.json" ] && [ -d "$PERSIST_DIR/.next" ]; then
  UPDATE_DECISION=$(node -e '
    const fs = require("fs");
    const cmp = (a, b) => {
      const pa = String(a || "0.0.0").replace(/^v/i, "").split("-")[0].split(".").map(Number);
      const pb = String(b || "0.0.0").replace(/^v/i, "").split("-")[0].split(".").map(Number);
      for (let i = 0; i < 3; i++) {
        if ((pa[i] || 0) > (pb[i] || 0)) return 1;
        if ((pa[i] || 0) < (pb[i] || 0)) return -1;
      }
      return 0;
    };
    const depsDiffer = (a, b) =>
      JSON.stringify((a && a.dependencies) || {}) !== JSON.stringify((b && b.dependencies) || {});
    try {
      const imgPkg = JSON.parse(fs.readFileSync("/app/package.json", "utf8"));
      const livePkg = JSON.parse(fs.readFileSync(process.argv[1] + "/package.json", "utf8"));
      const forceSync = fs.existsSync(process.argv[1] + "/.needs_npm_sync");
      if (forceSync) { console.log("APPLY_WITH_DEPS"); process.exit(0); }
      const c = cmp(livePkg.version, imgPkg.version);
      if (c < 0) { console.log("CLEAN_OLD"); process.exit(0); }
      let shouldApply = c > 0;
      if (!shouldApply) {
        const imgInfo = fs.existsSync("/app/BUILD_INFO.json") ? JSON.parse(fs.readFileSync("/app/BUILD_INFO.json", "utf8")) : {};
        const liveInfo = fs.existsSync(process.argv[1] + "/BUILD_INFO.json") ? JSON.parse(fs.readFileSync(process.argv[1] + "/BUILD_INFO.json", "utf8")) : {};
        if (liveInfo.commit && liveInfo.commit !== imgInfo.commit) {
          shouldApply = true;
        }
      }
      if (!shouldApply) { console.log("SKIP"); process.exit(0); }
      console.log(depsDiffer(livePkg, imgPkg) ? "APPLY_WITH_DEPS" : "APPLY");
    } catch {
      console.log("SKIP");
    }
  ' "$PERSIST_DIR")

  if [ "$UPDATE_DECISION" = "APPLY_WITH_DEPS" ] || [ "$UPDATE_DECISION" = "APPLY" ]; then
    echo "[NAS-Sync Entrypoint] Đang nạp bản cập nhật bền vững từ $PERSIST_DIR..."
    APPLY_OK=1
    if [ "$UPDATE_DECISION" = "APPLY_WITH_DEPS" ]; then
      echo "[NAS-Sync Entrypoint] Phát hiện thay đổi dependencies — đang cài đặt cô lập trong thư mục tạm..."
      DEPS_STAGE=$(mktemp -d /tmp/nas-sync-deps.XXXXXX)
      cp -a "$PERSIST_DIR/package.json" "$DEPS_STAGE/package.json"
      if [ -f "$PERSIST_DIR/package-lock.json" ]; then
        cp -a "$PERSIST_DIR/package-lock.json" "$DEPS_STAGE/package-lock.json"
        NPM_CMD="npm ci --omit=dev --no-audit --no-fund --ignore-scripts"
      else
        NPM_CMD="npm install --omit=dev --no-audit --no-fund --ignore-scripts"
      fi

      if (cd "$DEPS_STAGE" && $NPM_CMD); then
        rm -rf /app/node_modules.old
        if [ -d /app/node_modules ]; then
          mv /app/node_modules /app/node_modules.old
        fi
        mv "$DEPS_STAGE/node_modules" /app/node_modules
        rm -rf /app/node_modules.old "$DEPS_STAGE"
        rm -f "$PERSIST_DIR/.needs_npm_sync"
      else
        echo "[NAS-Sync Entrypoint] CẢNH BÁO: Cài đặt npm trong vùng tạm thất bại — giữ nguyên 100% Docker Image gốc."
        rm -rf "$DEPS_STAGE"
        APPLY_OK=0
      fi
    fi

    if [ "$APPLY_OK" = "1" ]; then
      for item in src public scripts .next server.ts package.json package-lock.json next.config.mjs postcss.config.mjs tailwind.config.ts tsconfig.json BUILD_INFO.json; do
        if [ -e "$PERSIST_DIR/$item" ]; then
          rm -rf "/app/$item"
          cp -a "$PERSIST_DIR/$item" "/app/$item"
        fi
      done
    fi
  elif [ "$UPDATE_DECISION" = "CLEAN_OLD" ]; then
    echo "[NAS-Sync Entrypoint] Docker Image mới hơn bản live_release cũ — dọn dẹp bản cũ..."
    rm -rf "$PERSIST_DIR"
  fi
fi

# Hạ đặc quyền từ root xuống tài khoản non-root (su-exec) khi môi trường lưu trữ cho phép
if [ "$(id -u)" = "0" ] && [ "${RUN_AS_ROOT:-false}" != "true" ] && command -v su-exec >/dev/null 2>&1; then
  LEGACY_ROOT_SNAP=0
  if [ -z "${PUID:-}" ]; then
    for entry in /mnt/vol1/* /mnt/vol2/*; do
      if [ -e "$entry" ]; then
        ENTRY_UID=$(stat -c '%u' "$entry" 2>/dev/null || echo 0)
        if [ "$ENTRY_UID" = "0" ]; then
          LEGACY_ROOT_SNAP=1
          break
        fi
      fi
    done
  fi

  if [ "$LEGACY_ROOT_SNAP" = "1" ]; then
    echo "[NAS-Sync Entrypoint] Phát hiện snapshot cũ thuộc quyền root (0:0) trên phân vùng lưu trữ — duy trì tương thích quyền truy cập (đặt PUID/PGID sau khi chown phân vùng để chạy non-root)."
  else
    TARGET_UID="${PUID:-1000}"
    TARGET_GID="${PGID:-1000}"
    if [ -z "${PUID:-}" ] && [ -d /mnt/vol1 ]; then
      VOL_UID=$(stat -c '%u' /mnt/vol1 2>/dev/null || echo 0)
      VOL_GID=$(stat -c '%g' /mnt/vol1 2>/dev/null || echo 0)
      if [ "$VOL_UID" != "0" ]; then
        TARGET_UID="$VOL_UID"
        TARGET_GID="$VOL_GID"
      fi
    fi

    mkdir -p "$DATA_ROOT/known_hosts" "${SSH_KEYS_DIR:-/app/ssh_keys}" /home/nassync/.ssh
    chown "$TARGET_UID:$TARGET_GID" /mnt/vol1 /mnt/vol2 2>/dev/null || true
    chown -R "$TARGET_UID:$TARGET_GID" /app "$DATA_ROOT" "${SSH_KEYS_DIR:-/app/ssh_keys}" /home/nassync 2>/dev/null || true
    chmod 700 "$DATA_ROOT/known_hosts" "${SSH_KEYS_DIR:-/app/ssh_keys}" /home/nassync/.ssh 2>/dev/null || true
    case "${SSH_KEYS_DIR:-}" in
      /root/*) chmod 711 /root 2>/dev/null || true ;;
    esac

    if [ ! -d /mnt/vol1 ] || su-exec "$TARGET_UID:$TARGET_GID" sh -c 'test -w /mnt/vol1' 2>/dev/null || [ -n "${PUID:-}" ]; then
      export HOME=/home/nassync
      exec su-exec "$TARGET_UID:$TARGET_GID" "$@"
    else
      echo "[NAS-Sync Entrypoint] CẢNH BÁO: Phân vùng /mnt/vol1 chưa cấp quyền ghi cho UID $TARGET_UID — vui lòng cấu hình PUID/PGID tương ứng với tài khoản quản lý trên NAS."
    fi
  fi
fi

exec "$@"
