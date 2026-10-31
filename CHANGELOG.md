# Changelog

Mọi thay đổi đáng chú ý của dự án **NAS-Sync** (<https://github.com/shostwp-byte/nas-sync>) đều được ghi nhận tại tài liệu này theo chuẩn [Keep a Changelog](https://keepachangelog.com/vi/1.1.0/) và [Semantic Versioning](https://semver.org/).

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

