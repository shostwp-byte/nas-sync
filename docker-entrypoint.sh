#!/bin/sh
set -e

PERSIST_DIR="${DATA_DIR:-/app/data}/live_release/current"

# Đồng bộ bản cập nhật từ vùng lưu trữ bền vững (/app/data/live_release/current) nếu mới hơn bản gốc trong Docker Image
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
      JSON.stringify((a && a.dependencies) || {}) !== JSON.stringify((b && b.dependencies) || {}) ||
      JSON.stringify((a && a.devDependencies) || {}) !== JSON.stringify((b && b.devDependencies) || {});
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
      echo "[NAS-Sync Entrypoint] Phát hiện thay đổi dependencies — đang đồng bộ npm packages..."
      cp -a "$PERSIST_DIR/package.json" "/app/package.json"
      if [ -f "$PERSIST_DIR/package-lock.json" ]; then
        cp -a "$PERSIST_DIR/package-lock.json" "/app/package-lock.json"
      fi
      if ! (cd /app && npm install --include=dev --no-audit --no-fund --ignore-scripts); then
        echo "[NAS-Sync Entrypoint] CẢNH BÁO: npm install thất bại, giữ nguyên bản gốc trong Docker Image."
        APPLY_OK=0
      else
        rm -f "$PERSIST_DIR/.needs_npm_sync"
      fi
    fi

    if [ "$APPLY_OK" = "1" ]; then
      for item in src public .next server.ts package.json package-lock.json next.config.mjs postcss.config.mjs tailwind.config.ts tsconfig.json BUILD_INFO.json; do
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

exec "$@"

