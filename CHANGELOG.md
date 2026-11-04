# Changelog

Mọi thay đổi đáng chú ý của dự án **NAS-Sync** (<https://github.com/shostwp-byte/nas-sync>) đều được ghi nhận tại tài liệu này theo chuẩn [Keep a Changelog](https://keepachangelog.com/vi/1.1.0/) và [Semantic Versioning](https://semver.org/).

## [1.7.3] - 2026-11-04

### Fixed (Tương thích Trình Cập nhật CLI `update.sh` trên Hệ điều hành Gốc NAS Cũ)
- **Chuỗi Xác thực Chữ ký `Ed25519` Đa Tầng Không Phụ thuộc Gói Host Cũ (`update.sh`)**:
  - Loại bỏ tiền tố `node:crypto` / `node:fs` (gây lỗi trên các thiết bị NAS cài sẵn gói Node.js v12 trên host) và tự động chuyển tiếp liền mạch qua chuỗi xác thực: **Host `node` (≥ v12)** → **Container `nas_sync_core` đang chạy (`docker exec`)** → **Host `openssl` (kiểm tra trước cờ `-rawin` & khóa SPKI Ed25519)** → **`docker run --network none node:24-alpine`**, giữ nguyên nguyên tắc Fail-Closed trước mọi chữ ký giả mạo.
  - Bọc toàn bộ kịch bản `update.sh` trong hàm `main() { ... }` để việc tự ghi đè `./update.sh` trong lúc cập nhật không bao giờ làm lệch con trỏ đọc kịch bản của tiến trình Bash đang chạy.

## [1.7.2] - 2026-11-04

### Fixed & Improved (Gia cố Độ tin cậy Lịch Khóa WORM Snapshot 06:00 AM & Chẩn đoán Trực tiếp)
- **Tách biệt Timeout Kết nối Mạng/TLS và Timeout Thực thi WORM (`worm-snapshot.ts`)**:
  - Tách bộ đếm thời gian chờ mở kết nối TCP/TLS (`12 giây` — phát hiện nhanh lỗi sai cổng hoặc Tường lửa NAS chặn dải mạng Docker) khỏi bộ đếm thời gian chờ xử lý tác vụ trên NAS (`45 giây` cho bước xác thực và **`120 giây`** cho bước đồng bộ & khóa cứng Btrfs/ZFS/Webhook WORM Snapshot), chấm dứt lỗi báo quá hạn `15 giây` giả khi dàn ổ cứng RAID thức dậy từ chế độ ngủ đông (HDD Hibernation) lúc 06:00 sáng hoặc khi phân vùng lưu trữ có dung lượng lớn.
  - Sử dụng kết nối HTTP/HTTPS độc lập (`agent: false`, `Connection: close`) cho từng truy vấn WORM để tránh kẹt socket Keep-Alive cũ và áp dụng tức thì cấu hình kiểm tra chứng chỉ TLS mới nhất.
  - Tự động thử lại bước đăng nhập `NAS_WEBAPI` khi dàn ổ cứng đang quay khởi động lần đầu, tự động tương thích lùi Auth WebAPI `v6 -> v3` (mã `104`), và dịch chi tiết các lỗi mạng/TLS tự ký cũng như mã lỗi WebAPI (`400`, `402`, `403` 2FA/OTP, `407` Auto Block) sang hướng dẫn tiếng Việt cụ thể.
- **Nút Lưu & Chụp thử WORM Snapshot Trực tiếp & Hiển thị Trạng thái Chính xác (`src/app/settings/page.tsx`, `src/app/volumes/page.tsx`, `docker-compose.yml`)**:
  - Bổ sung nút **"Lưu & Chụp thử WORM Snapshot ngay"** ngay trong thẻ cấu hình WORM tại trang Cài đặt và sửa màu cảnh báo đỏ (`AlertTriangle`) khi chụp thử thất bại trên trang Phân vùng Lưu trữ.
  - Khai báo sẵn `extra_hosts: ["host.docker.internal:host-gateway"]` cho dịch vụ `nas_sync_core` trong `docker-compose.yml`.

## [1.7.1] - 2026-11-03

### Security & Reliability Hardening (Xử lý Triệt để Bản Đánh giá An ninh & Độ tin cậy Lần 3)
- **Khôi phục MySQL Restore trên cPanel/DirectAdmin & Sửa cú pháp `find -P` trên aaPanel (`S13`, `S9` — `restore-worker.ts`, `aapanel.ts`)**:
  - Đổi thứ tự tham số truyền cho client `mariadb`/`mysql` để `--defaults-extra-file=...` luôn đứng đầu tiên trước `--binary-mode`, khắc phục lỗi `unknown variable 'defaults-extra-file=...'` khi khôi phục MySQL/MariaDB.
  - Chuẩn hóa cú pháp `find -P . ! -type l` đúng chuẩn POSIX/GNU/BusyBox trong lệnh phân quyền webroot của `AaPanelAdapter`.
- **Gia cố Tuyệt đối Luồng PostgreSQL Backup/Restore & Bộ lọc SQL (`S12`, `S6`, `N29` — `postgres-streamer.ts`, `sql-stream-guard.ts`, `sandbox-verifier.ts`, `backup-worker.ts`)**:
  - Chuyển định dạng sao lưu PostgreSQL mới sang **`pg_dump -Fc` (Custom Archive `PGDMP`)** kết hợp `pg_restore --no-owner --no-privileges --no-ACL`, loại bỏ hoàn toàn bề mặt thực thi meta-command của `psql`.
  - Đối với các bản sao lưu plain-SQL cũ: bắt buộc `psql` trên máy chủ đích phải hỗ trợ cờ `\restrict` (PostgreSQL ≥ 17.6 / 16.10 / 15.14, nếu không sẽ từ chối an toàn fail-closed), kết nối trực tiếp bằng role của user sở hữu database qua `PGPASSWORD_FILE` (tuyệt đối không chạy dưới quyền superuser `postgres`), nâng cấp máy trạng thái từ vựng SQL khóa toàn bộ 6 ngả lách (`"..."` identifier, `-- \r` comment, dollar-quote lỗi cú pháp, `standard_conforming_strings = off`, `client_encoding` đa byte không phải UTF-8, `ident$E'...'`) và cho phép truyền dòng dữ liệu `COPY ... FROM stdin` lớn hơn `64 MiB` không giới hạn kích thước dòng.
- **Thống nhất Chu kỳ Retry BullMQ, Bảo vệ Điểm Commit Snapshot & Cô lập Sandbox (`N18`–`N27`, `S14`, `S2`, `S3` — `queue.ts`, `backup-worker.ts`, `restore-worker.ts`, `sandbox-verifier.ts`, `rsync-runner.ts`, `config-rewriter.ts`, `worker-state.ts`)**:
  - Đồng bộ `attempts: MAX_BACKUP_RETRIES + 1` trên BullMQ kèm sự kiện dự phòng `bullWorker.on('failed')` và báo cáo Morning Digest, đảm bảo lần thử cuối cùng luôn chuyển trạng thái `FAILED` và phát cảnh báo `CRITICAL`.
  - Tước bỏ cờ `setuid`/`setgid` và UID/GID số từ bản sao lưu khi chạy `rsync` (`--no-owner --no-group --chmod=ugo-s`), hạ quyền `rsync --server` xuống user của website qua `runuser`, cấm fallback chạy `root` trong `config-rewriter.ts`, bảo vệ Snapshot đã commit ở pha `VERIFYING`, kiểm tra `!isJobCancelled` trước khi ném `RetryableNetworkError`, tách tài khoản MariaDB Sandbox riêng cho từng `jobId`, và xóa cây thư mục Snapshot bất đồng bộ không chặn Event Loop.
- **Khóa Chuỗi Cung ứng Phát hành, Chữ ký `Ed25519` cho `update.sh` & Quản trị RBAC/Offsite (`U6`–`U16`, `A5`, `A9`–`A18`, `O7`, `C1`, `S10`, `S17`, `E2`)**:
  - Áp dụng `environment: release-signing`, kiểm tra commit thuộc nhánh `main`, `npm ci --ignore-scripts`, chứng thực nguồn gốc `actions/attest-build-provenance`, gom khóa công khai `Ed25519` về một module duy nhất `release-public-key.mjs`, ký số cả gói `nas-sync-bundle.tar.gz.sig` và bắt buộc `update.sh` xác thực chữ ký fail-closed, kiểm tra mã băm `package-lock.json` và chặn hạ cấp phiên bản trái phép.
  - Dọn sạch các khóa cấu hình thế hệ cũ khỏi bảng `system_settings` + lọc `GET /api/settings` theo danh sách cho phép, bỏ đóng gói sẵn `.env` trong bundle, bắt buộc quản trị viên xác thực lại mật khẩu (+ mã 2FA nếu đang bật) khi đặt lại mật khẩu/2FA cho tài khoản khác, chặn `OPERATOR` chạy lại tác vụ `RESTORE`, ghim cứng IP đã kiểm duyệt cho S3 Endpoint chống DNS Rebinding (`O7`), nâng độ dài tối thiểu mật khẩu mã hóa Offsite lên `12` ký tự (`C1`), bắt buộc HTTPS mặc định cho kết nối WORM qua mạng (`S10`) kèm khóa `zfs hold` đệ quy cho child dataset (`S17`), và gia cố `login-throttle.ts` / `.totp_secret` fail-closed.

## [1.7.0] - 2026-11-03

### Added & Changed (Kiến trúc Đa Nền tảng NAS — Universal Multi-NAS & Docker Edition)
- **Bộ Kiểm định Năng lực Phân vùng Tự động (`probeVolumeCapabilities` — `volume-manager.ts`, `src/app/volumes/page.tsx`)**:
  - Tự động nhận diện loại hệ thống tệp thực tế (`ZFS`, `Btrfs`, `Ext4`, `XFS`, `fuse.shfs`, `SMB/NFS`, `NTFS`) qua `/proc/mounts` / `df -PT` và kiểm tra nguyên tử khả năng tạo POSIX Hard-Link, Symlink cùng quyền ghi của `PUID/PGID` trên từng phân vùng lưu trữ.
  - Hiển thị huy hiệu trực quan (`FS`, `Hard-Link OK`, `Ghi/Đọc OK`) và cảnh báo hướng dẫn tối ưu trên trang **Phân vùng Lưu trữ** cũng như nhật ký Pre-Flight trước mỗi ca sao lưu.
- **Engine Khóa Bất biến Đa Nhà cung cấp (`triggerImmutableWormSnapshot` — `worm-snapshot.ts`, `/api/volumes/snapshot`, `src/app/settings/page.tsx`)**:
  - Nâng cấp cơ chế khóa Snapshot chống Ransomware cấp hệ điều hành sang kiến trúc đa chế độ (`worm_provider`):
    1. `NONE`: Khóa GFS Pinning nội bộ kết hợp tầng Offsite 3-2-1 Zero-Knowledge (tương thích mặc định 100% thiết bị NAS & Docker).
    2. `TRUENAS_ZFS`: Tích hợp **TrueNAS SCALE REST API v2.0** (`POST /api/v2.0/zfs/snapshot` + `POST /api/v2.0/zfs/snapshot/hold`) kèm tự động giải phóng các bản chụp hết hạn `retentionDays`.
    3. `NAS_WEBAPI`: Tích hợp chuẩn **Btrfs Share Snapshot WebAPI** (`is_locked=true`) qua giao diện cấu hình trung lập.
    4. `WEBHOOK`: Tích hợp **Universal Host Snapshot Webhook** ký số `HMAC-SHA256` (`X-NasSync-Signature`) cho QNAP QuTS hero, Unraid, OpenMediaVault và máy chủ Linux ZFS/Btrfs/LVM.
- **Chuẩn hóa Thương hiệu Trung lập Đa Hãng NAS & Di chuyển Cấu hình Tự động (`db.ts`, Giao diện Web, PWA, CLI & CI/CD)**:
  - Gỡ bỏ toàn bộ định danh giới hạn một hãng đơn lẻ trên giao diện Web, PWA Manifest, thông báo hệ thống, nhãn OCI Docker và gói phát hành; tự động chuyển đổi không gián đoạn nhãn phân vùng mặc định sang `NAS Volume X` và ánh xạ cấu hình cũ sang bộ khóa chuẩn `worm_*` khi nâng cấp từ các phiên bản trước.
  - Bổ sung trình cài đặt & cập nhật tự động đa nền tảng **`install.sh`** và **`update.sh`** (tự nhận diện TrueNAS SCALE, QNAP Container Station, UGREEN UGOS Pro, TerraMaster TOS, Asustor ADM, Unraid, OpenMediaVault, Linux Docker và xác minh mã băm `SHA-256` của gói `nas-sync-bundle.tar.gz`).
  - Viết lại toàn diện **`README.md`** và cẩm nang **`HUONG-DAN-CAI-DAT-NAS.md`** kèm ma trận tương thích chi tiết cho đa dòng thiết bị NAS.

## [1.6.0] - 2026-11-03

### Security & Reliability Hardening (Xử lý Toàn diện Bản Đánh giá An ninh & Độ tin cậy)
- **Chặn đứng RCE qua SQL Client & Luồng PostgreSQL (`S1`, `S6` — `sandbox-verifier.ts`, `restore-worker.ts`, `sql-stream-guard.ts`, `postgres-streamer.ts`)**:
  - Bổ sung cờ bắt buộc `--binary-mode` cho mọi tiến trình nạp `mariadb`/`mysql` để vô hiệu hóa hoàn toàn các lệnh thực thi client (`\!`, `system`, `source`) bên trong file dump từ VPS không tin cậy.
  - Xây dựng bộ lọc luồng trạng thái dòng `createSafePsqlRestoreTransform` chặn mọi meta-command `psql` (`\!`, `\i`, `\o`, `\copy`), `COPY ... PROGRAM`, `CREATE LANGUAGE ...u`, leo thang `SUPERUSER` và `SET SESSION AUTHORIZATION` trước khi đẩy vào `psql -X -v ON_ERROR_STOP=1` dưới quyền `SET SESSION AUTHORIZATION <targetUser>`.
- **Chống Symlink Clobber & TOCTOU Leo thang Đặc quyền Root trên VPS (`S2`, `S3`, `S5`, `S9`, `S11` — `config-rewriter.ts`, `adapters/**`, `rsync-runner.ts`, `restore-worker.ts`, `extended-hosting-backup.ts`)**:
  - Thay thế thao tác ghi đè cấu hình web dưới quyền `root` bằng kiểm tra symlink từng đoạn đường dẫn, hạ quyền xuống user sở hữu website và ghi tạm qua `mktemp` (`O_EXCL`) + `mv -f`.
  - Bổ sung cơ chế khóa Inode thư mục làm việc `buildJailedRsyncPath` (`realpath -e` + `cd -P` + `pwd -P` ngay trong cùng tiến trình con trước khi `exec rsync`), thêm `--no-keep-dirlinks` khi Restore, siết chặt kiểm tra jail trên CyberPanel/Plesk/Maildir, chạy `chmod` aaPanel dưới quyền user `www` kèm cờ `! -type l`, và gỡ bỏ truyền mật khẩu MySQL dư thừa khi quét tên miền.
- **Gia cố Hàng đợi BullMQ, Quản lý Process Group & Cảnh báo Khi Hết Retry (`N1`, `N2`, `N4`, `N6`, `N7`, `N8`, `N11`, `N12`, `N14` — `queue.ts`, `worker-state.ts`, `backup-worker.ts`, `restore-worker.ts`, `snapshot-pins.ts`)**:
  - Khóa CAS nguyên tử khi nhận Job, đặt `attempts: 1` + `UnrecoverableError` cho mọi tác vụ `RESTORE` (ngăn chạy đè 10 lần khi đứt mạng giữa chừng), và ghim đọc `SnapshotReadPin` ngăn GFS Retention xóa nhầm Snapshot đang chạy Restore / tải ZIP / đẩy Offsite.
  - Bỏ hoàn toàn lớp bọc trung gian `bash -c`, nối trực tiếp luồng giải nén Node.js vào `stdin` kèm `detached: true` và tiêu diệt toàn bộ Process Group (`-pid`) khi hủy hoặc quá hạn; tự động chuyển sang `FAILED` + phát cảnh báo `CRITICAL` + dọn sạch thư mục `.in_progress_*` khi dùng hết số lần retry; tách biệt hậu kiểm sau điểm commit nguyên tử (`renameSync`) để lỗi Sandbox không làm hỏng trạng thái `COMPLETED` của bản sao lưu.
- **Xác thực Chữ ký số Ed25519 Bắt buộc cho Self-Updater & Kênh CI/CD (`U1`–`U5`, `E1`, `R1`, `R2` — `release-signature.ts`, `updater.ts`, `docker-entrypoint.sh`, `Dockerfile`, `.github/workflows/release.yml`, `update-synology.sh`)**:
  - Mặc định 1-Click Self-Updater chỉ chấp nhận các gói GitHub Release chính thức có đầy đủ tệp băm `.sha256` và chữ ký số **Ed25519 (`.sig`)** hợp lệ; sao lưu delta `node_modules` để hoàn tác nguyên tử cùng mã nguồn nếu lỗi; khóa tương tranh giữa Self-Update và Cron/Offsite.
  - Cô lập `npm ci --omit=dev` vào thư mục tạm trong `docker-entrypoint.sh`, tách riêng bước build không đặc quyền với bước ký số phát hành trong `release.yml` (ghim cứng commit SHA cho mọi GitHub Action), bảo toàn `docker-compose.yml` trong `update-synology.sh`, và bổ sung chạy container dưới tài khoản non-root `nassync` qua `su-exec`.
- **An toàn Sao lưu Đám mây Offsite `NASSYNC2`, Backpressure & Watchdog (`O1`–`O6`, `C1`, `N3`, `N5` — `offsite-cloud.ts`, `offsite-crypto.ts`, `explorer/**`, `sandbox-verifier.ts`, `scripts/decrypt-offsite-backup.mjs`)**:
  - Khắc phục triệt để lỗi lọc tiền tố trên Google Drive (`web` không bao giờ xóa nhầm bản sao lưu của `web-2`) kết hợp gắn nhãn `appProperties` và phân trang `nextPageToken`; tính kích thước part S3 động tới `512 MiB` hỗ trợ gói lớn hơn `78 GiB`; đồng bộ offset Google Drive Resumable Upload khi retry; chặn SSRF tới dải IP nội bộ/metadata cho S3 Endpoint tùy chỉnh; chờ xác nhận mã thoát `tar === 0` trước khi hoàn tất upload.
  - Nâng cấp luồng mã hóa lên chuẩn **`NASSYNC2`** (`PBKDF2-HMAC-SHA256` 600.000 vòng bất đồng bộ + gắn toàn bộ 49 bytes Header làm AAD cho mọi khung `AES-256-GCM`), giữ tương thích giải mã ngược 100% với `NASSYNC1` và gỡ bỏ nhận mật khẩu trần trên dòng lệnh `process.argv` của công cụ giải mã độc lập.
  - Áp dụng Pull Backpressure chuẩn (`pause`/`resume` theo `desiredSize`) cho API tải tệp/gói nén Explorer tránh tràn RAM OOM, và cập nhật đồng hồ hoạt động theo tiến độ đọc byte cho luồng nạp SQL lớn.
- **Phòng thủ Chiều sâu API, RBAC, Socket.IO, SSH TOFU & 2FA TOTP (`A1`–`A8`, `S4`, `S7`, `S8`, `S10`, `N9`, `N10`, `N13`, `N15`–`N17`, ESLint)**:
  - Chuẩn hóa toàn bộ API trả lỗi qua `safeErrorJson`, mở đúng quyền `/api/alerts` cho `VIEWER`/`OPERATOR`, phân luồng room theo vai trò và thu hồi tức thì phiên Socket.IO bị hủy, tách khóa mã hóa 2FA riêng (`v2:`) độc lập với `JWT_SECRET`, bổ sung chống phát lại mã TOTP (`totp_last_used_step`), chống dò tên đăng nhập qua thời gian phản hồi, khóa đổi `hostname` khi đã có Snapshot, bật kiểm tra chứng chỉ TLS DSM mặc định, bỏ cờ yếu `+ssh-rsa` / `accept-new` và tích hợp cấu hình ESLint chuẩn vào quy trình kiểm thử CI.

## [1.5.6] - 2026-11-03

### Fixed
- **Khắc phục lỗi cú pháp Shell POSIX (`sh: 6: Syntax error: "(" unexpected`) khi quét Domain/Database trên DirectAdmin, cPanel & CyberPanel (`directadmin.ts`, `cpanel.ts`, `cyberpanel.ts`, `postgres-streamer.ts`, `ssh.ts`)**:
  - Sửa lỗi thoát chuỗi `\"` bên trong template literal của TypeScript ở lệnh truy vấn danh sách PostgreSQL (`ALL_PG_DBS=...`) trên `DirectAdminAdapter` và `CPanelAdapter` — chuyển toàn bộ sang cơ chế đóng gói một chiều `shellSingleQuote(...)` chuẩn POSIX `sh` (`dash` / `bash`), loại bỏ hoàn toàn lồng ngoặc kép phức tạp.
  - Chuẩn hóa bộ lọc `sed` đọc thông tin `/root/.my.cnf` trên `CPanelAdapter` và `CyberPanelAdapter`, tránh lỗi thoát dấu nháy đơn trong template literal.
  - Cải tiến hàm bọc `wrapZeroImpact` trong `src/lib/ssh.ts` sang cấu trúc điều kiện `if ...; then ...; else ...; fi` kèm kiểm tra quyền `ionice -c 2 -n 7 true`, đảm bảo câu lệnh từ xa chỉ thực thi đúng 1 lần duy nhất thay vì chạy lặp lần thứ hai khi trả về mã lỗi khác `0`.
  - Bổ sung bộ kiểm thử hồi quy tự động chạy `sh -n` kiểm tra cú pháp POSIX Shell cho toàn bộ script SSH sinh ra bởi cả 7 Control Panel Adapter trong `tests/security-and-engine.test.ts`.
- **Khắc phục triệt để lỗi ngắt kết nối `kex_exchange_identification: read: Connection reset by peer` trên VPS bật CSF `PORTFLOOD` / `MaxStartups` (`ssh.ts`, `directadmin.ts`, `backup-worker.ts`, `queue.ts`, `updater.ts`)**:
  - Bỏ thao tác gọi lặp `ssh-keyscan` (vốn mở đồng thời 5 kết nối TCP chưa xác thực dễ chạm ngưỡng CSF `PORTFLOOD` / `PerSourceMaxStartups`) đối với các máy chủ đã ghim khóa `VERIFIED`, ủy quyền xác thực trực tiếp cho `StrictHostKeyChecking=yes` + `UserKnownHostsFile` và chỉ quét lại khi phát hiện cảnh báo thay đổi Host Key.
  - Kích hoạt cơ chế gộp kênh OpenSSH Multiplexing (`ControlMaster=auto`, `ControlPersist=90s`, `ConnectionAttempts=3`) cho cả `ssh` và `rsync`, tái sử dụng duy nhất 1 kết nối TCP cho toàn bộ phiên sao lưu của mỗi VPS, đồng thời gộp đọc thông tin MySQL vào chung 1 lượt gọi SSH trong `DirectAdminAdapter.discoverDomains` và giãn cách `1.5s` khi lập lịch Cron nhiều VPS cùng giờ.
  - Bổ sung cơ chế tự động thử lại tức thì (3 lần kèm backoff) trong `execRemoteSSH` khi gặp lỗi rơi gói bắt tay KEX (`kex_exchange_identification` / `Connection reset by peer`), và tự động chuyển Job sang trạng thái `INTERRUPTED` (`Auto-Resume`) thay vì `FAILED` nếu cổng SSH đang bị tường lửa giới hạn tạm thời.
- **Tối ưu hóa toàn diện thanh 5 Tab & bố cục Mobile trên trang `Cấu hình & Cập nhật` (`src/app/settings/page.tsx`, `src/app/alerts/page.tsx`, `src/app/globals.css`)**:
  - Thiết kế lại thanh điều hướng 5 tab (`Cấu hình`, `Sao lưu`, `Tài khoản`, `Phân quyền`, `Cập nhật`) dạng Segmented Bar 5 cột 1 hàng duy nhất trên màn hình di động (`320px` – `639px`) với bộ icon Lucide đồng nhất và chấm trạng thái trực quan, chấm dứt tình trạng chữ bị bẻ gãy thành nhiều dòng lệch chiều cao.
  - Sửa xung đột Flexbox `w-full flex-1` ở nhóm nút hành động trong tab **Cập nhật**, tách dòng mô tả toàn chiều rộng cho thẻ **Báo cáo Tổng hợp Sáng sớm**, chuẩn hóa lưới 2×2 cho bộ chọn S3, lưới 3 cột cho khung giờ Cron và tối ưu kích thước vùng chạm trên toàn bộ 5 tab.

## [1.5.5] - 2026-11-02

### Changed
- **Lược bỏ Tab `Nhật ký Kiểm toán (Audit Logs)` trùng lặp trong trang `Cấu hình & Cập nhật` (`src/app/settings/page.tsx`)**:
  - Gỡ bỏ tab **Nhật ký Kiểm toán (Audit Logs)** tại `/settings` để quy tụ toàn bộ nhật ký sự kiện và kiểm toán bảo mật về một nơi duy nhất tại menu **Nhật ký & Cảnh báo** (`/alerts`), giúp thanh điều hướng của `/settings` gọn gàng còn đúng 5 tab chức năng (`Cấu hình Hệ thống`, `Sao lưu`, `Tài khoản & Bảo mật 2FA`, `Phân quyền Người dùng (RBAC)`, `Cập nhật`).

## [1.5.4] - 2026-11-02

### Added & Improved
- **Tách riêng Tab `Sao lưu` (Offsite Cloud 3-2-1) & Tối ưu Bố cục 2 cột tại `/settings` (`src/app/settings/page.tsx`, `src/app/jobs/page.tsx`)**:
  - Đưa toàn bộ khối **Sao lưu Đám mây Offsite chuẩn 3-2-1 (Mã hóa Đầu-Cuối AES-256-GCM)** sang tab độc lập **Sao lưu** (kèm hỗ trợ chuyển hướng Google Drive OAuth2 & `?tab=backup`) và lược bỏ icon đám mây trùng lặp trước tiêu đề.
  - Sắp xếp lại lưới cấu hình tại tab **Cấu hình Hệ thống**: đưa thẻ **Bộ lọc Loại trừ File Toàn cục (Global Exclude Rules)** nằm ngang hàng cân đối với thẻ **Báo cáo Tổng hợp Sáng sớm (Daily Morning Digest)**.

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

