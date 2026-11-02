# Changelog

Mọi thay đổi đáng chú ý của dự án **NAS-Sync** (<https://github.com/shostwp-byte/nas-sync>) đều được ghi nhận tại tài liệu này theo chuẩn [Keep a Changelog](https://keepachangelog.com/vi/1.1.0/) và [Semantic Versioning](https://semver.org/).

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

