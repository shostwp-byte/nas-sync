#!/bin/sh
set -e

PERSIST_DIR="${DATA_DIR:-/app/data}/live_release/current"

# Đồng bộ bản cập nhật từ vùng lưu trữ bền vững (/app/data/live_release/current) nếu mới hơn bản gốc trong Docker Image
if [ -f "$PERSIST_DIR/package.json" ] && [ -d "$PERSIST_DIR/.next" ]; then
  SHOULD_APPLY=$(node -e '
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
    try {
      const imgPkg = JSON.parse(fs.readFileSync("/app/package.json", "utf8"));
      const livePkg = JSON.parse(fs.readFileSync(process.argv[1] + "/package.json", "utf8"));
      const c = cmp(livePkg.version, imgPkg.version);
      if (c > 0) { console.log("APPLY"); process.exit(0); }
      if (c < 0) { console.log("CLEAN_OLD"); process.exit(0); }
      const imgInfo = fs.existsSync("/app/BUILD_INFO.json") ? JSON.parse(fs.readFileSync("/app/BUILD_INFO.json", "utf8")) : {};
      const liveInfo = fs.existsSync(process.argv[1] + "/BUILD_INFO.json") ? JSON.parse(fs.readFileSync(process.argv[1] + "/BUILD_INFO.json", "utf8")) : {};
      if (liveInfo.commit && liveInfo.commit !== imgInfo.commit) { console.log("APPLY"); } else { console.log("SKIP"); }
    } catch {
      console.log("SKIP");
    }
  ' "$PERSIST_DIR")

  if [ "$SHOULD_APPLY" = "APPLY" ]; then
    echo "[NAS-Sync Entrypoint] Đang nạp bản cập nhật bền vững từ $PERSIST_DIR..."
    for item in src .next server.ts package.json next.config.mjs postcss.config.mjs tailwind.config.ts tsconfig.json BUILD_INFO.json; do
      if [ -e "$PERSIST_DIR/$item" ]; then
        rm -rf "/app/$item"
        cp -a "$PERSIST_DIR/$item" "/app/$item"
      fi
    done
  elif [ "$SHOULD_APPLY" = "CLEAN_OLD" ]; then
    echo "[NAS-Sync Entrypoint] Docker Image mới hơn bản live_release cũ — dọn dẹp bản cũ..."
    rm -rf "$PERSIST_DIR"
  fi
fi

exec "$@"

