# Changelog

Mọi thay đổi đáng chú ý của dự án **NAS-Sync** (<https://github.com/shostwp-byte/nas-sync>) đều được ghi nhận tại tài liệu này theo chuẩn [Keep a Changelog](https://keepachangelog.com/vi/1.1.0/) và [Semantic Versioning](https://semver.org/).

## [1.5.3] - 2026-11-02

### Added & Improved
- **Tách riêng Tab `Cập nhật` trong trang `Cấu hình & Cập nhật` (`src/app/settings/page.tsx`, `src/components/AppShell.tsx`)**:
  - Đưa toàn bộ mục **Cập nhật Hệ thống Trực tiếp từ GitHub (1-Click Self-Update)** ra khỏi tab cấu hình chung thành tab độc lập **Cập nhật** đặt ở cuối cùng (sau tab **Nhật ký Kiểm toán - Audit Logs**), đồng thời đổi tên tab đầu tiên thành **Cấu hình Hệ thống**.
  - Hỗ trợ điều hướng trực tiếp qua tham số `?tab=update` và `?tab=account` kèm huy hiệu báo phiên bản mới ngay trên nút tab **Cập nhật**.

## [1.5.2] - 2026-11-02

### Added & Improved
- **Tách riêng Menu Điều hướng `Nhật ký & Cảnh báo` (`/alerts`, `src/app/api/alerts/route.ts`, `AppShell.tsx`, `settings/page.tsx`)**:
  - Đưa toàn bộ mục **Nhật ký Sự kiện & Cảnh báo Hệ thống** ra khỏi trang `Cấu hình & Cập nhật` sang một menu độc lập **Nhật ký & Cảnh báo** trên thanh điều hướng Sidebar kèm huy hiệu đếm thông báo chưa đọc theo thời gian thực.
  - Bổ sung bộ lọc nhanh theo mức độ (`Chưa đọc`, `CRITICAL`, `WARNING`, `INFO`), phân mục (`BACKUP`, `RESTORE`, `ANOMALY`, `VOLUME`, `BTRFS`, `SYSTEM`), ô tìm kiếm tức thì, đánh dấu đã đọc từng mục / tất cả, dọn dẹp thông báo cũ và tích hợp thẻ xem nhanh **Nhật ký Kiểm toán Bảo mật (Audit Logs)** dành cho `ADMIN`.

## [1.5.1] - 2026-11-02

### Fixed
- **Khắc phục lỗi quyền ghi `/mnt/vol1` (`EACCES`) khi chạy kiểm thử `npm test` trên GitHub Actions Ubuntu Linux & khôi phục xuất bản gói Release tự động (`tests/security-and-engine.test.ts`, `offsite-cloud.ts`, `explorer/archive/route.ts`)**:
  - Cô lập hoàn toàn biến môi trường `STORAGE_VOLUMES` (kèm ngưỡng `VOLUME_MIN_FREE_GB=0`, `VOLUME_MAX_USAGE_PERCENT=99`) vào thư mục tạm `os.tmpdir()` trong bộ kiểm thử tự động — xử lý triệt để lỗi non-root runner trên Ubuntu Linux ghi vào đường dẫn mặc định `/mnt/vol1` của container khiến tiến trình CI và đóng gói GitHub Release (`nas-sync-prebuilt.tar.gz` + `.sha256` + `nas-sync-synology.zip/.tar.gz`) bị dừng ở bước test.
  - Chuẩn hóa thứ tự cờ lệnh `tar -czf - --exclude=... -C <dir> <entry>` tương thích đồng nhất trên cả GNU `tar`, BSD `libarchive` `tar` và BusyBox `tar`.

## [1.5.0] - 2026-11-02

### Added & Improved (Giai đoạn 3 — Mở rộng Nghiệp vụ Hosting, Đám mây Offsite `3-2-1` Google Drive/S3 & 7 Control Panels + PostgreSQL)
- **Sao lưu Đám mây Offsite Chuẩn `3-2-1` Mã hóa Đầu-Cuối `AES-256-GCM` hỗ trợ `Google Drive` & `S3 / Cloudflare R2 / Backblaze B2` (`src/lib/engine/offsite-crypto.ts`, `src/lib/engine/offsite-cloud.ts`, `api/offsite/**`, `scripts/decrypt-offsite-backup.mjs`, `settings/page.tsx`, `jobs/page.tsx`)**:
  - Thiết kế định dạng mã hóa luồng xác thực `NASSYNC1` (`PBKDF2-HMAC-SHA256` 210.000 vòng + các khung `AES-256-GCM` kèm khung kết thúc chống cắt cụt `NASSYNC1-EOF`) nối trực tiếp từ `tar -czf -` lên đám mây mà **không tốn dung lượng tạm trên ổ cứng NAS**.
  - Tích hợp **Google Drive REST API v3 (`Resumable Upload`)**: hỗ trợ cả **OAuth2 1-Click** (dành cho Gmail cá nhân, Google One & Google Workspace với luồng tự động lấy `Refresh Token` tại `/api/offsite/gdrive-oauth`) lẫn **Service Account JSON (`RS256` JWT)** và tự động nhận diện link thư mục Drive / Shared Drive.
  - Tích hợp **AWS Signature v4 thuần `node:crypto` (`Multipart Upload`)** tương thích **Cloudflare R2**, **Backblaze B2**, **AWS S3**, **MinIO**, hỗ trợ tự động đẩy sau mỗi lần Backup / Chủ nhật hàng tuần, đẩy thủ công 1-Click trên trang Lịch sử Job, tự động dọn bản cũ theo `offsite_keep_count` và đi kèm công cụ giải mã khẩn cấp độc lập `node scripts/decrypt-offsite-backup.mjs`.
- **Sao lưu Mở rộng Hệ thống Hosting: Hộp thư Email, Crontab & Cấu hình Webserver/SSL (`src/lib/engine/extended-hosting-backup.ts`, `servers/page.tsx`)**:
  - Bổ sung 3 tùy chọn độc lập cho từng máy chủ VPS: **Hộp thư Email (`Maildir / IMAP`)** sử dụng `rsync --link-dest` tiết kiệm dung lượng kèm kiểm tra chống thoát vùng symlink, **Lịch Crontab của từng User** và **Cấu hình Vhost/SSL** lưu trữ gọn trong `system_extras/` của mỗi Snapshot (duyệt & tải trực tiếp được trên File Explorer).
- **Mở rộng lên 7 Control Panel (`CyberPanel`, `HestiaCP`, `CloudPanel`) & Hỗ trợ Cơ sở dữ liệu `PostgreSQL` (`cyberpanel.ts`, `hestiacp.ts`, `cloudpanel.ts`, `postgres-streamer.ts`, `sandbox-verifier.ts`, `restore/page.tsx`)**:
  - Bổ sung đầy đủ Adapter khám phá tự động, kiểm tra an toàn Webroot Jail và khôi phục chéo cho **CyberPanel (OpenLiteSpeed)**, **HestiaCP** và **CloudPanel** bên cạnh DirectAdmin, cPanel, Plesk, aaPanel.
  - Hỗ trợ sao lưu stream không tốn đĩa tạm (`pg_dump | zstd -3`), kiểm định toàn vẹn luồng Zstd + cấu trúc dump PostgreSQL và khôi phục tự động (`psql`) cho cơ sở dữ liệu **PostgreSQL** song song với MySQL/MariaDB.

## [1.4.0] - 2026-11-02

### Added & Improved (Giai đoạn 2 — An ninh Chiều sâu, Báo cáo NOC Thông minh, PWA & Tối ưu Docker/CI)
- **Ghim Vân tay Máy chủ SSH (`SSH Host Key TOFU Pinning`) & Bộ lọc Lỗi API (`src/lib/ssh.ts`, `src/lib/api-error.ts`, `api/servers/[id]/host-key/route.ts`, `servers/page.tsx`)**:
  - Tự động quét và ghim vân tay định danh OpenSSH (`SHA256:...` chuẩn RFC 4253) của từng VPS ngay lần kết nối đầu tiên vào kho `known_hosts` biệt lập (`chmod 600`) kèm chế độ kiểm tra nghiêm ngặt `StrictHostKeyChecking=yes` trên mọi lệnh `ssh` và `rsync`.
  - Phát hiện tức thì hành vi đổi Host Key bất thường (tấn công MITM hoặc cài lại OS), tự động khóa mọi kết nối Sao lưu/Khôi phục trên VPS đó, phát cảnh báo khẩn cấp `CRITICAL` và cung cấp quy trình xác nhận Host Key mới dành riêng cho `ADMIN` (lưu vết đầy đủ vào `audit_logs`).
  - Bổ sung bộ lọc `sanitizeErrorMessage` / `safeErrorJson` che giấu đường dẫn nội bộ máy chủ và stack trace thô khỏi phản hồi API lỗi `500`.
- **Báo cáo Tổng hợp Sáng sớm (`Daily Morning Digest`) & Phân tích Dung lượng 30 Ngày (`src/lib/engine/morning-digest.ts`, `api/settings/digest/route.ts`, `page.tsx`, `settings/page.tsx`)**:
  - Lập lịch tự động gửi báo cáo tổng hợp hàng sáng (mặc định `07:00`, hỗ trợ bấm gửi thử 1-Click ngay trong Cài đặt) qua **Telegram & SMTP Email**: thống kê 24h qua (số Job thành công/thất bại, dung lượng tăng ròng, tỷ lệ tiết kiệm Hard-Link, số CSDL đạt `Verified ✅`, cảnh báo SSH TOFU & dung lượng trống từng Volume).
  - Bổ sung bảng `storage_daily_stats` (tự động tổng hợp ngược lịch sử từ `backup_jobs`) cùng **Biểu đồ Tăng trưởng Dung lượng 30 Ngày** tương tác và bảng **Top 10 Website / Domain Dung lượng Lớn nhất** ngay trên Dashboard NOC.
- **Ứng dụng Di động Độc lập (`PWA — Progressive Web App`) (`src/app/manifest.ts`, `public/icons/*`, `public/sw.js`, `PwaRegistrar.tsx`, `layout.tsx`)**:
  - Hỗ trợ cài đặt **NAS-Sync** trực tiếp ra màn hình chính iOS (`apple-mobile-web-app-capable`) và Android/Desktop Chrome ở chế độ toàn màn hình `standalone` với bộ biểu tượng Dark NOC chuyên biệt và Service Worker an toàn (không bao giờ lưu đệm `/api/*` hay `/socket.io/*`).
- **Kiến trúc Worker Mô-đun hóa, Bộ Kiểm thử Tự động `node:test` & Docker Image Đa Kiến trúc `GHCR` (`worker-state.ts`, `rsync-runner.ts`, `mysql-streamer.ts`, `mock-runner.ts`, `tests/security-and-engine.test.ts`, `Dockerfile`, `ci.yml`, `release.yml`)**:
  - Tách nhỏ `backup-worker.ts` thành 5 module chuyên biệt rõ ràng, dễ bảo trì và mở rộng.
  - Bổ sung 14 bài kiểm thử tự động toàn diện chạy trên `node:test` tích hợp sẵn của Node.js 24 (**không phát sinh thêm bất kỳ gói phụ thuộc npm nào**, giữ nguyên 100% tốc độ cập nhật Prebuilt ~5 giây trên NAS) vào quy trình kiểm định `CI`.
  - Tối ưu `Dockerfile` (`npm ci`) và bổ sung GitHub Actions xuất bản tự động Docker Image đa kiến trúc (`linux/amd64`, `linux/arm64`) lên `ghcr.io/shostwp-byte/nas-sync`.

## [1.3.1] - 2026-11-02

### Fixed
- **Khắc phục triệt để lỗi `ETXTBSY: Text file busy '/app/node_modules/@esbuild/linux-x64/bin'` khi Tự động Cập nhật 1-Click trên Linux/Synology Docker (`src/lib/qr-svg.ts`, `src/lib/totp.ts`, `src/lib/updater.ts`, `docker-entrypoint.sh`)**:
  - Thay thế hoàn toàn gói `qrcode` bên ngoài bằng bộ mã hóa QR Code SVG chuẩn **ISO/IEC 18004 thuần TypeScript (`src/lib/qr-svg.ts`)** không phụ thuộc thư viện ngoài — giữ nguyên 100% danh sách `dependencies` tương thích ngược với `v1.1.x` / `v1.2.0` để các thiết bị NAS đang chạy phiên bản cũ có thể nâng cấp thẳng lên `v1.3.1` bằng 1-Click ngay trên Web UI mà không cần can thiệp SSH.
  - Bổ sung cơ chế đồng bộ thư viện POSIX an toàn `syncNodeModulesSafe()` trong `updater.ts`: tự động bỏ qua các gói không đổi phiên bản (`name@version`), thực hiện `unlink()` tách inode trước khi sao chép file mới thay vì ghi đè `O_TRUNC` lên binary đang thực thi (`esbuild` / `swc`), kết hợp cờ `.needs_npm_sync` trong `docker-entrypoint.sh` cho mọi bản cập nhật tương lai.

## [1.3.0] - 2026-11-02

### Added & Improved (Giai đoạn 1 — 5 Nâng cấp Lõi Ưu tiên Cao)
- **Tải trọn bộ Website / Thư mục dạng `.tar.gz` Stream trực tiếp (`src/app/api/explorer/archive/route.ts`, `explorer/page.tsx`, `jobs/page.tsx`, `restore/page.tsx`)**:
  - Bổ sung API `GET /api/explorer/archive` nén stream trực tiếp thư mục bất kỳ hoặc trọn bộ 1 Domain (`public_html` + `databases` + `metadata.json`) về trình duyệt mà không tạo file tạm trên ổ cứng NAS, không đi theo symlink ngoại lai và tự động hủy tiến trình `tar` ngay khi đóng/hủy tải.
- **Bộ lọc Loại trừ File Rác (`Custom Rsync Exclude Rules` — `src/lib/engine/exclude-rules.ts`, `backup-worker.ts`, `settings/page.tsx`, `servers/page.tsx`)**:
  - Hỗ trợ cấu hình mẫu loại trừ toàn cục (`global_exclude_patterns` kèm nút chèn nhanh bộ lọc rác chuẩn WordPress/Hosting) kết hợp với mẫu loại trừ riêng từng VPS (`servers.custom_excludes`), tự động kiểm duyệt an toàn trước khi truyền `--exclude` vào `rsync`.
- **Tự động Cập nhật File Cấu hình khi Di chuyển Chéo Panel (`src/lib/engine/config-rewriter.ts`, `restore-worker.ts`, `restore/page.tsx`)**:
  - Tự động tạo bản dự phòng `.nas-sync.bak` (`0600`) và cập nhật tên Database (`targetDbMap`) cùng đường dẫn vật lý mới trong `wp-config.php`, `.env`, `configuration.php`, `config.php`, `app/etc/env.php` sau khi khôi phục sang VPS đích.
- **Cập nhật Siêu tốc `Prebuilt Release + SHA-256` & Khôi phục `1-Click Rollback` (`scripts/package-prebuilt.mjs`, `.github/workflows/release.yml`, `updater.ts`, `settings/page.tsx`)**:
  - Đóng gói sẵn bản biên dịch Production (`nas-sync-prebuilt.tar.gz`) kèm chữ ký băm `.sha256` trên GitHub Releases; trình cập nhật tự kiểm tra `SHA-256` bằng `timingSafeEqual` và nạp trực tiếp trong **~5 giây** không tốn CPU/RAM chạy `next build` trên NAS, đồng thời lưu giữ bản trước đó hỗ trợ **1-Click Rollback**.
- **Bảo mật 2 lớp (`2FA TOTP`), Phân quyền Đa Tài khoản (`RBAC`) & Nhật ký Kiểm toán (`Audit Logs`) (`src/lib/totp.ts`, `src/lib/audit.ts`, `server.ts`, `api/auth/2fa`, `api/users`, `api/audit-logs`, `login/page.tsx`, `settings/page.tsx`, `AppShell.tsx`)**:
  - Hỗ trợ xác thực 2 lớp chuẩn **RFC 6238 (`HMAC-SHA1`, mã QR SVG, 8 mã khôi phục dự phòng mã hóa `AES-256-GCM`)**, biến khẩn cấp `FORCE_RESET_ADMIN_2FA=true`, phân quyền 3 cấp (`ADMIN`, `OPERATOR`, `VIEWER`) kiểm tra trực tiếp từ SQLite ở tầng HTTP Server và bảng nhật ký kiểm toán `audit_logs` lưu vết toàn bộ thao tác nhạy cảm.

## [1.2.0] - 2026-11-02

### Security & Reliability
- **Khóa chặt thực thi lệnh SSH/Rsync & Chống leo thang đặc quyền qua Symlink (`src/lib/ssh.ts`, `src/lib/engine/adapters/**`, `backup-worker.ts`, `restore-worker.ts`)**:
  - Luôn truyền `-F /dev/null` trong `ssh` và `rsync` để vô hiệu hóa tấn công `ProxyCommand` qua `/root/.ssh/config`; chặn đặt tên khóa hệ thống (`config`, `authorized_keys`, `known_hosts`, `rc`, `environment`), kiểm định định dạng khóa bằng `ssh-keygen -lf` và bắt buộc `ssh_key_path` nằm gọn trong thư mục khóa ứng dụng.
  - Kiểm tra `realpath` vùng giam (Jail) của `webroot` theo tài khoản Linux (`getent passwd`) trước khi Pull/Push nhằm chặn symlink trỏ ra `/root`, `/etc` hoặc sang tài khoản khác; bổ sung `--no-devices --no-specials --safe-links` cho `rsync`, đổi `chown -R` thành `chown -hR` và phân tách quyền thư mục `755` / tập tin `644` trên aaPanel.
- **Ẩn hoàn toàn mật khẩu Master MySQL khỏi `ps aux` / `/proc/<pid>/cmdline` (`base.ts`, `directadmin.ts`, `cpanel.ts`, `plesk.ts`, `aapanel.ts`, `sandbox-verifier.ts`)**:
  - Loại bỏ cờ `-p'...'` trên mọi dòng lệnh `mysql` / `mysqldump`, chuyển sang đọc trực tiếp biến môi trường nội bộ `MYSQL_PWD` từ file cấu hình root trên VPS hoặc `env` của tiến trình con trên NAS.
- **Bảo vệ Phiên đăng nhập (`token_version`), Chống CSRF & Che giấu Secret (`server.ts`, `src/middleware.ts`, `src/lib/db.ts`, `src/app/api/settings/route.ts`, `src/lib/engine/btrfs-worm.ts`)**:
  - Kiểm tra khớp `Origin` / `Host` trên mọi API thay đổi trạng thái (`POST/PUT/PATCH/DELETE`) và Socket.IO `io.use()`; bổ sung cột `token_version` thu hồi ngay lập tức mọi phiên JWT cũ khi đổi mật khẩu hoặc đăng xuất; chống giả mạo `X-Forwarded-For` khi chưa bật `TRUST_PROXY=true` và giới hạn độ dài mật khẩu `<= 256` ký tự.
  - Che giấu (`••••••••`) các khóa nhạy cảm (`telegram_bot_token`, `smtp_pass`, `dsm_password`, `github_token`) trên `GET /api/settings`, ẩn `REDIS_URL` khỏi `/api/health`, và chuyển Synology DSM Btrfs WORM API sang phương thức `POST` kèm hỗ trợ HTTPS tự ký nội bộ.
- **Khóa Mutex theo Máy chủ, An toàn GFS Retention, Chống Gzip Bomb/FIFO & Gia cố Self-Update (`queue.ts`, `retention-gfs.ts`, `explorer.ts`, `updater.ts`, `docker-entrypoint.sh`)**:
  - Khóa tuần tự FIFO theo `server_id` tránh đụng độ Backup/Restore/Retention trên cùng VPS; bảo vệ không xóa Snapshot đang được tiến trình Restore sử dụng; chỉ cập nhật con trỏ `latest` sau khi vượt qua kiểm tra Ransomware Anomaly & SQL Sandbox; đồng bộ múi giờ Local cho GFS; bổ sung timeout & hủy tiến trình con toàn diện; sao lưu SQLite nguyên tử bằng `VACUUM INTO` khi cập nhật.

### Mobile UX/UI
- **Chuẩn hóa Giao diện Mobile-First (`320px` – `1024px`) trên toàn bộ 12 tập tin Frontend (`layout.tsx`, `globals.css`, `AppShell.tsx` & 9 màn hình chính)**:
  - Khai báo `viewport` chuẩn (`viewportFit: 'cover'`, `themeColor`), chặn lỗi iOS Safari tự phóng to khi chạm ô nhập liệu (`font-size: 16px` dưới `768px`), thêm lớp nền mờ `Backdrop Overlay` + khóa cuộn trang nền cho menu ngăn kéo và huy hiệu cảnh báo `CRITICAL` trên thanh Header di động.
  - Bổ sung giao diện **Thẻ Di động (Mobile Cards)** song song với bảng Desktop cho danh sách **Máy chủ VPS**, **Tiến trình & Lịch sử**, **Phiên gần nhất**, **Quét thử Domain** và **Chi tiết Job** (hiển thị đầy đủ huy hiệu `Verified ✅` và nút `Restore` trên điện thoại).
  - Bổ sung thanh chuyển nhanh **`📁 Cây thư mục` / `📄 Xem File / Diff`** trên điện thoại cho File Explorer, sửa triệt để lỗi tràn ngang ô nhập GFS trong Modal Tạo Lịch, căn thẳng hàng các ô ngưỡng Volume/Ransomware và tự động cuộn mượt giữa các bước Khôi phục.

## [1.1.5] - 2026-10-31

### Security & Changed
- **Hợp nhất bản vá bảo mật từ PR #1 (`19e6269`)**:
  - Tự sinh khóa `JWT_SECRET` ngẫu nhiên lưu bền vững tại `app_data/.jwt_secret`, xác thực phiên cho Socket.IO Realtime và giới hạn dò mật khẩu đăng nhập (`HTTP 429`).
  - Kiểm duyệt chặt tên Domain, System User, Database, Hostname/IP chống Shell Injection & Path Traversal; bảo vệ Symlink trong File Explorer và tải file lớn bằng Stream.
- **Chuẩn hóa toàn diện định danh `NAS-Sync` / `nas_sync` trên toàn bộ mã nguồn**:
  - Đồng bộ 100% tên Cookie phiên (`nas_sync_session`), tên hàng đợi BullMQ (`nas-sync-backup-jobs`), biến global runtime, khóa SSH tạm, phiên Synology DSM WORM API (`NasSyncWORM`), dữ liệu mô phỏng Demo, `package-lock.json` và toàn bộ chuỗi hiển thị trên giao diện/log sang `NAS-Sync` (tự động đổi tên file CSDL thế hệ cũ sang `nas-sync.db` không mất dữ liệu).

## [1.1.4] - 2026-10-31

### Added & Improved
- **Đổi Tên đăng nhập (Username) Admin trực tiếp trên giao diện Web (`src/app/api/auth/me/route.ts`, `src/app/settings/page.tsx`, `src/app/login/page.tsx`)**:
  - Cho phép đổi `Username` quản trị độc lập (chỉ cần xác nhận mật khẩu hiện tại, không bắt buộc đổi mật khẩu) hoặc đổi đồng thời cả `Username` & `Mật khẩu` ngay tại trang **Cấu hình & Cập nhật (`/settings`)**, tự động cấp mới phiên JWT mà không bị đăng xuất.
  - Hỗ trợ đặt lại đồng thời cả `ADMIN_USERNAME` và `ADMIN_PASSWORD` khi bật `FORCE_RESET_ADMIN_PASSWORD=true` trong `.env`.

## [1.1.3] - 2026-10-31

### Added & Improved
- **Nâng cấp Cảnh báo Telegram & SMTP Email (`src/lib/notifications.ts`, `src/app/api/settings/route.ts`, `src/app/settings/page.tsx`)**:
  - Bổ sung nút **`Tự lấy Chat ID`** giúp tự động dò và điền `Telegram Chat ID / Group ID` chỉ với 1 click sau khi nhắn `/start` cho Bot.
  - Tách biệt rõ ràng trạng thái **`Bỏ qua (Chưa nhập)`** và **`Gửi thất bại ❌`** thay vì gộp chung `"Chưa cấu hình/Lỗi"`, đồng thời hiển thị thông báo tiếng Việt chi tiết ngay bên trong thẻ cấu hình (phát hiện tự động lỗi điền nhầm ID của chính con Bot vào Chat ID).
  - Chống trình duyệt tự động điền nhầm tài khoản đăng nhập Web vào ô `SMTP User` & `SMTP Password`.

## [1.1.2] - 2026-10-31

### Fixed & Improved
- **Sửa lỗi báo trạng thái `FULL` sai trên ổ cứng / phân vùng có dung lượng trống < 200 GB (`src/lib/engine/volume-manager.ts`, `src/lib/db.ts`, `src/app/volumes/page.tsx`)**:
  - Hạ ngưỡng mặc định `VOLUME_MIN_FREE_GB` (`min_free_gb`) từ `200 GB` xuống `10 GB` (kèm migration tự động cho CSDL đang chạy từ phiên bản cũ) để tránh báo `FULL` sai khi tỷ lệ sử dụng mới ở mức thấp (VD: 52%) nhưng ổ cứng nhỏ hoặc bị giới hạn Shared Folder Quota trên DSM.
  - Xóa độ trễ hysteresis `-3%` gây kẹt trạng thái `FULL` khi người dùng chỉnh lại ngưỡng đầy, hỗ trợ đặt `Trống tối thiểu (GB) = 0` để chỉ tính theo `%`.
  - Hiển thị rõ nguyên nhân báo `FULL` và dung lượng bị giữ chỗ bởi Hạn ngạch DSM Quota / LUN ngay trên thẻ Phân vùng.

## [1.1.1] - 2026-10-31

### Fixed & Improved
- **Đổi mật khẩu Quản trị Admin (`/api/auth/me` & `/settings`)**:
  - Bổ sung thông báo trạng thái trực quan ngay trên khung Đổi mật khẩu (thay cho hộp thoại `alert` có thể bị trình duyệt chặn), kèm nút Hiện/Ẩn mật khẩu.
  - Tự động đối chiếu dự phòng theo `username` khi phiên JWT cũ lệch ID với CSDL và cấp mới cookie phiên đăng nhập ngay sau khi đổi mật khẩu.
  - Bổ sung biến môi trường khôi phục mật khẩu khẩn cấp `FORCE_RESET_ADMIN_PASSWORD=true` trong `.env`.

## [1.1.0] - 2026-10-30

### Added
- **Quét, Sao lưu & Khôi phục Subdomain toàn diện trên cả 4 Control Panel**:
  - **DirectAdmin**: Đọc đầy đủ `<domain>.subdomains` và giải mã `<domain>.subdomains.docroot.override` (hỗ trợ cả webroot độc lập `/domains/sub.domain.com/public_html` lẫn webroot lồng nhau `/domains/domain.com/public_html/sub`).
  - **cPanel**: Hỗ trợ Subdomain trong `/etc/userdatadomains`, tự động lọc trùng companion subdomain của Addon Domain.
  - **Plesk Obsidian**: Mở rộng truy vấn `psa.domains` bao gồm cả `subdomain` và kế thừa `sys_users` từ Subscription cha.
  - **aaPanel**: Đọc bổ sung bảng `binding` (Subdirectory Binding) và các site WordPress Toolkit (`WP2`).
  - **Tự động khớp Database theo mã nguồn** (`wp-config.php`, `.env`, `configuration.php`) để gán đúng DB cho từng Subdomain.
  - **Nested Webroot Deduplication**: Tự động truyền `--exclude` cho thư mục con lồng nhau để tránh tải trùng 2 lần và bảo vệ thư mục Subdomain không bị xóa nhầm khi Restore domain cha.
  - Hiển thị huy hiệu `SUB` trực quan tại màn hình Quét thử, Khôi phục và Nhật ký.
- **Tính năng 1-Click Update trực tiếp từ GitHub (`shostwp-byte/nas-sync`)**:
  - Kiểm tra phiên bản & commit mới qua GitHub API, hiển thị Changelog, tự động sao lưu SQLite trước khi nâng cấp, biên dịch cô lập trong vùng Staging, lưu bền vững qua `docker-entrypoint.sh` và tự động khởi động lại không cần mount `docker.sock`.
  - Bổ sung script CLI `update-synology.sh`.
- **Chuẩn hóa Mã nguồn Mở `nas-sync` (MIT License)**:
  - Bổ sung đầy đủ `LICENSE`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `.gitattributes`, `.editorconfig`, GitHub Issue/PR Templates và GitHub Actions CI/Release Workflows.

### Changed
- Chuẩn hóa thương hiệu, package và cấu hình Docker sang `nas-sync` (giữ tương thích ngược 100% CSDL đang chạy từ v1.0.0).
- Tối ưu trình khách SSH tương thích ngược OpenSSH cũ (ẩn cảnh báo `WarnWeakCrypto`, hỗ trợ `ssh-rsa`, tự động xử lý quyền `0600` trên phân vùng Synology Btrfs có Windows ACL).
- Bổ sung cơ chế quét dung lượng ổ cứng đa tầng (`/bin/busybox df -k -P` + `seccomp:unconfined`) tương thích mọi phiên bản Kernel Synology DSM.

## [1.0.0] - 2026-10-30

### Added
- Phiên bản nền tảng đầu tiên: Kiến trúc Agentless Pull qua SSH, Incremental Hard-Link (`rsync --link-dest`), Zero-Temp-Disk SQL Stream (`zstd`/`gzip`), Multi-Volume Overflow + Local Seeding, Auto-Resume, MariaDB Sandbox Verification, Ransomware Anomaly Detection + Synology Btrfs WORM API, GFS Retention, Web File Explorer & Code Diff Viewer.

