# Code Review lần 3 — nhánh `wnreview`

Re-review NAS-Sync từ `81dbf5b` (v1.5.6, mốc của review lần 2) đến `75563a8` (`main`, v1.7.0):
3 commit (v1.6.0, fix CI, v1.7.0), 105 file, khoảng +10.200 / −2.700 dòng.
Review này chỉ đọc code, không sửa code dự án.

## Đánh giá chung

v1.6.0 xử lý gần như toàn bộ danh sách của review lần 2, và đa số bản sửa đúng hướng:

- **MySQL:** đã dùng `--binary-mode` (thêm `--sandbox` nếu client hỗ trợ), nên đường RCE qua
  `\!` vào NAS đã bị chặn.
- **Rsync:** chạy trong cùng một phiên `cd -P` + kiểm tra `pwd -P`.
- **Config rewriter:** chạy dưới user của site, dùng `mktemp` + `mv`.
- **Hủy job:** dùng process group (`kill(-pid)`) thay cho pipeline `bash -c`.
- **Claim job:** nguyên tử bằng `UPDATE … WHERE status IN (…)`; restore không còn bị retry.
- **Updater:** mặc định chỉ cài release đã ký Ed25519.
- **Offsite:** prefix Google Drive được lọc chính xác, part S3 tính theo dung lượng, NASSYNC2 có
  header nằm trong AAD.
- **Auth:** TOTP chống replay, khóa 2FA tách khỏi `JWT_SECRET`, Socket.IO kiểm tra lại
  `token_version`.
- **Khác:** đã có ESLint và 29 test.

Không còn mục **Nghiêm trọng** nào. Còn lại 5 mục **Cao**:

1. **S12:** bộ lọc `sql-stream-guard` cho PostgreSQL bị bypass được. Khi psql ở VPS đích không có
   `\restrict`, dump độc vẫn chạy được `\!` dưới user `postgres`.
2. **S13:** đặt `--binary-mode` *trước* `--defaults-extra-file` làm **mọi restore MySQL** hỏng
   trên cPanel và trên HestiaCP/CyberPanel/CloudPanel khi dùng `.my.cnf`. Đây là regression do
   chính bản sửa S1 gây ra.
3. **N18:** ở chế độ BullMQ, lần retry cuối không chuyển job sang FAILED và không gửi cảnh báo
   (N4 cũ mới sửa cho Local mode).
4. **U6, U7:** chữ ký release chỉ an toàn bằng mức bảo vệ của pipeline CI. Push một tag `v*` bất
   kỳ là được ký tự động, và job build vẫn chạy script cài đặt của dependency trước khi đóng gói.

Ngoài ra có vài lỗi chức năng mới: `find . -P` của aaPanel sai cú pháp nên `chmod` không bao
giờ chạy (S9), và bundle release có sẵn `.env` nên bước setup của `install.sh` bị bỏ qua (U11).

## Trạng thái các mục của review lần 2

### Bảo mật: shell, SSH, dữ liệu từ VPS

| Mục | Trạng thái | Bằng chứng | Ghi chú |
|---|---|---|---|
| S1 | ⚠️ Sửa một phần | `sandbox-verifier.ts:65-73, 147-156`, `restore-worker.ts:175`, `postgres-streamer.ts:247-251, 402-418` | MySQL đã đóng. PostgreSQL chỉ an toàn khi psql đích có `\restrict`; nếu không có, chỉ còn bộ lọc tự viết, mà bộ lọc này bypass được (**S12**). Thứ tự cờ ở restore làm hỏng MySQL restore (**S13**). |
| S2 | ✅ Đã sửa (còn sót nhỏ) | `config-rewriter.ts:50-70, 92-127` | Đã hạ quyền sang user site, dùng `mktemp` + `mv -f`, chặn symlink theo từng đoạn path. Khi user site là root hoặc không tồn tại, script vẫn fallback chạy `sh -c` bằng root (dòng 66-67), và `mv` không có `-T`. |
| S3 | ⚠️ Sửa một phần | `base.ts:69-86`, `rsync-runner.ts:173-176`, `restore-worker.ts:95-98`, `extended-hosting-backup.ts:159-162` | Race ở thư mục gốc đã đóng. Rsync phía remote vẫn chạy root trong cây thư mục khách ghi được: nếu khách đổi thư mục con thành symlink sau khi rsync dựng xong file list, rsync vẫn đọc hoặc ghi ra ngoài cây. Đề xuất chạy rsync bằng user site chưa được làm (*cần xác nhận theo phiên bản rsync*). |
| S4 | ✅ Đã sửa | `ssh.ts:486-519`, `709-732`, `773-789` | Key quét được phải là tập con của key đã pin; key mới chuyển sang MISMATCH. Đã bỏ `+ssh-rsa`. |
| S5 | ✅ Đã sửa | `base.ts:201-252` | Jail CyberPanel đã gắn với home của user site. |
| S6 | ⚠️ Sửa một phần, bypass được | `postgres-streamer.ts:233-244, 263-265, 405-407`, `sql-stream-guard.ts:37-41` | Chỉ `SET SESSION AUTHORIZATION` khi role tồn tại và không phải superuser. Kết nối vẫn được xác thực bằng `postgres`, nên dump đổi ngược lại được: guard cho qua `SET session_authorization = postgres;` và `set_config('session_authorization', …)`. Sau đó `DO $$ … COPY … TO PROGRAM $$` cũng lọt, vì guard không kiểm tra nội dung bên trong dollar-quote (*phía guard đã xác nhận, phía PostgreSQL cần xác nhận*). |
| S7 | ✅ Đã sửa | `ssh.ts:701-706, 765-770` | Không còn fallback `accept-new` + `/dev/null`. |
| S8 | ✅ Đã sửa | `ssh.ts:165-202` | Socket ControlMaster nằm trong `DATA_DIR/.ssh_mux`, có kiểm tra symlink, owner và mode. |
| S9 | ❌ **Bản sửa bị lỗi** | `aapanel.ts:185-191` | `find . -P …` sai cú pháp (`-P` phải đứng trước path). GNU find báo `unknown predicate '-P'` và thoát với mã 1, nên `chmod` không bao giờ chạy trên aaPanel. `restore-worker.ts:661-664` chỉ log một warning. Sửa: `find -P . ! -type l …`. Test `sh -n` không bắt được lỗi này. |
| S10 | ✅ Đã sửa (còn sót) | `worm-snapshot.ts:29, 35-40, 73, 342` | TLS đã được kiểm tra mặc định. Nhưng vẫn chấp nhận URL `http://`, nên mật khẩu admin NAS và bearer key TrueNAS có thể đi dạng plaintext. |
| S11 | ✅ Đã sửa | `directadmin.ts:24-45`, `cpanel.ts:24-47`, `cyberpanel.ts:24-56`, `hestiacp.ts:30-60` | Chỉ username được gửi về NAS; mật khẩu được đọc ngay trên VPS. |
| N13 | ✅ Đã sửa | `volume-manager.ts:249-264` | Tạo symlink tạm rồi `renameSync`, có báo lỗi. |

### Bảo mật: updater, release, offsite

| Mục | Trạng thái | Bằng chứng | Ghi chú |
|---|---|---|---|
| U1 | ⚠️ Sửa một phần | `updater.ts:66-68, 1146, 1179-1279`, `release.yml:3-6, 77-107` | Mặc định chỉ cài `releases/latest` có tarball + `.sha256` + `.sig`, và `force` không còn fallback về `main`. Cài từ `main` HEAD chỉ khi đặt `ALLOW_UNVERIFIED_MAIN_UPDATE=true` (biến này compose không truyền vào container). Lỗ còn lại: mọi tag push lên đều được ký (**U6**). |
| U2 | ✅ Đã sửa cho gói prebuilt | `release-signature.ts:9-11, 35-42, 64-88`, `updater.ts:1237, 1259-1279` | Chữ ký phủ `nas-sync-release-v1\|<tag>\|<sha256>`, được kiểm tra trước khi tải và sau khi tính hash, fail-closed. Public key được nhúng trong code. Bundle dùng cho `install.sh`/`update.sh` vẫn chưa được ký (**U9**). |
| U3 | ✅ Phần lớn đã sửa | `updater.ts:1574-1612, 1652-1674` | `node_modules` được swap sau bước snapshot, có backup delta và khôi phục trong catch. Còn sót nhỏ ở **U14**. |
| U4 | ✅ Đã sửa | `updater.ts:245-262`, `offsite-cloud.ts:1590`, `queue.ts:407, 495-503, 636, 967, 1018` | Cron, BullMQ, local queue và offsite đều tôn trọng cờ "đang cập nhật". Row UPLOADING bị kẹt được dọn khi khởi động. |
| U5 | ✅ Đã sửa | `updater.ts:1327-1336, 1386-1416` | Tải `tar.gz/<sha>` theo đúng SHA đã resolve. |
| E1 | ⚠️ Đã sửa trong source, chưa tới bản cập nhật qua UI | `docker-entrypoint.sh:7-85` | Đã cài vào thư mục tạm rồi mới swap. Nhưng updater 1-click không bao giờ cập nhật entrypoint (**U8**). |
| R1 | ⚠️ Sửa một phần | `release.yml:8-56, 58-120, 122-124` | Đã tách job build (read-only, `persist-credentials: false`) khỏi job publish, pin action theo SHA (đã xác minh 9 SHA khớp tag), và `docker-ghcr` có `needs: build`. Job build vẫn chạy `npm ci` có script cài đặt (**U7**). |
| R2 | ⚠️ Sửa một phần | `update.sh:49-101` | Mặc định theo tag release, giữ nguyên `docker-compose.yml` (bản mới lưu thành `.dist`). Nhưng không kiểm tra chữ ký và có các đường fallback không xác thực (**U9**). |
| O1 | ✅ Đã sửa | `offsite-cloud.ts:86-110, 834-838, 1406-1414` | Lọc tên file bằng regex chính xác cộng `appProperties.nasSyncHostname`. |
| O2 | ✅ Đã sửa | `offsite-cloud.ts:116-126, 639-641, 699-705` | Part từ 8 đến 512 MiB, có assert ≤ 10.000 part. |
| O3 | ✅ Đã sửa | `offsite-cloud.ts:1628-1649` | Bắt buộc COMPLETED và server không có backup đang chạy. |
| O4 | ✅ Đã sửa | `offsite-cloud.ts:653-655, 756-793, 1651-1681` | Chờ tar thoát mã 0 rồi mới commit, abort multipart khi lỗi, và giới hạn upload song song. |
| O5 | ⚠️ Sửa một phần | `offsite-cloud.ts:132-261, 534, 558` | Đã chặn IP nội bộ, đặt `redirect: 'error'` và cắt gọn body lỗi. Vẫn còn DNS rebinding (**O7**). |
| O6 | ✅ Đã sửa | `offsite-cloud.ts:1123-1163, 1236-1256` | Hỏi offset bằng `bytes */*` trước khi gửi lại. |
| C1 | ✅ Đã sửa | `offsite-crypto.ts:27-65, 178-185, 328-347`, `decrypt-offsite-backup.mjs:318-338` | Header nằm trong AAD, PBKDF2 600k vòng (async) với tham số lưu trong header, EOF được xác thực. Vẫn tương thích ngược NASSYNC1. CLI không nhận passphrase qua argv. Độ dài passphrase tối thiểu vẫn là 8 (`offsite-cloud.ts:1602`). |
| Dockerfile | ⚠️ Sửa một phần | `Dockerfile:1-11, 73`, `docker-entrypoint.sh:87-133` | Build nhiều stage, runtime không còn devDependencies, và app chạy bằng PUID qua `su-exec`. Entrypoint vẫn chạy root để `npm ci` và `chown -R` mỗi lần boot (**E2**). App vẫn chạy root nếu đặt `RUN_AS_ROOT=true`. |

### Độ tin cậy: hàng đợi, job, mất dữ liệu

| Mục | Trạng thái | Bằng chứng | Ghi chú |
|---|---|---|---|
| N1 | ✅ Phần lớn đã sửa | `queue.ts:313-363, 830-845`, `jobs/[id]/route.ts:177-194` | Claim nguyên tử có kiểm tra `changes === 0`, restore ném `UnrecoverableError`, jobId cố định, chặn retry job COMPLETED/INTERRUPTED. Còn một đường chạy lại (**N19**). |
| N2 | ✅ Đã sửa | `worker-state.ts:45-73`; spawn detached ở `rsync-runner.ts:180`, `mysql-streamer.ts:46, 120`, `restore-worker.ts:102, 180, 242`, `postgres-streamer.ts:277, 301`, `sandbox-verifier.ts:153, 236`, `archive/route.ts:109` | Đã bỏ pipeline `bash -c`; Node pipe thẳng vào stdin của ssh/mariadb. |
| N3 | ✅ Đã sửa | `archive/route.ts:138-216` | Có backpressure qua `pause()` / `pull()`; khi abort thì kill cả process group. |
| N4 | ⚠️ **Chỉ sửa cho Local mode** | `backup-worker.ts:783-808`, `queue.ts:620, 844` | BullMQ mode vẫn hở (**N18**). Digest vẫn chỉ đếm FAILED (`morning-digest.ts:122, 190, 369`). |
| N5 | ⚠️ Sửa một phần | `restore-worker.ts:263-296`, `postgres-streamer.ts:323-325`, `sandbox-verifier.ts:18-39` | Restore đã tính byte đọc là hoạt động. Timeout sandbox có scale nhưng chặn trần ở 90 phút, và khi timeout hoặc bị hủy vẫn đánh **CORRUPTED** thay vì UNTESTED (`sandbox-verifier.ts:299-315, 909-916, 970`). |
| N6 | ✅ Đã sửa | `backup-worker.ts:826-829`, `worker-state.ts:211-269` | |
| N7 | ✅ Đã sửa | `queue.ts:491-569, 677-692` | |
| N8 | ✅ Đã sửa (còn hở) | `queue.ts:415-436, 640-650` | Nhả lock không drain lại local queue (**N24**). |
| N9 | ✅ Đã sửa | `notifications.ts:52-67, 460-504` | |
| N10 | ✅ Đã sửa | `servers/[id]/route.ts:65-80` | Không cho đổi hostname khi server đã có job. Xóa server vẫn để lại dữ liệu mồ côi (**N25**). |
| N11 | ⚠️ Sửa một phần | `restore-worker.ts:53, 657-660, 809-812` | Timeout nâng lên 15 phút nhưng vẫn là timeout cứng, và không hủy được. |
| N12 | ✅ Đã sửa | `backup-worker.ts:587-688` | |
| N14 | ✅ Đã sửa | `queue.ts:191-239, 725-749` | |
| N15 | ✅ Đã sửa | `servers/route.ts:64-73`, `servers/[id]/route.ts:51-64` | |
| N16 | ⚠️ Sửa một phần | `server.ts:18-24` | Đã có handler, nhưng `uncaughtException` chỉ log rồi chạy tiếp. Nếu một handler stream ném lỗi đồng bộ trước khi settle (ví dụ `mysql-streamer.ts:167`, `postgres-streamer.ts:92`), promise treo mãi và job kẹt ở RUNNING, giữ cả lock lẫn slot. |
| N17 | ✅ Phần lớn đã sửa | `explorer.ts:172, 318, 346`, `rsync-runner.ts:17`, `queue.ts:289-307`, `db.ts:349-357` | Diff đã giới hạn 1 MiB nhưng `diffLines` vẫn chạy đồng bộ. WORM batch còn lỗi (**N26**). |
| Retention vs explorer/verify | ✅ Đã sửa | `snapshot-pins.ts`, `archive/route.ts:101`, `download/route.ts:67`, `retention-gfs.ts:161` | Pin được kiểm tra, rồi `rmSync` chạy đồng bộ ngay sau, không có await xen giữa. |

### Auth, API, RBAC

| Mục | Trạng thái | Bằng chứng | Ghi chú |
|---|---|---|---|
| A1 | ✅ Đã sửa (còn sót) | Mọi catch đều dùng `safeErrorJson` / `sanitizeErrorMessage` | Còn route mới `volumes/snapshot/route.ts:11-12` (**A16**). |
| A2 | ✅ Đã sửa | `server.ts:153, 179`, `alerts/route.ts:21, 115, 131, 152` | |
| A3 | ✅ Đã sửa | `server.ts:340-392`, `events.ts:40-46, 91-98` | Kiểm tra lại mỗi lần broadcast và mỗi 15s; tiến trình update chỉ gửi cho ADMIN. |
| A4 | ✅ Đã sửa | `totp.ts:224-294`, `2fa/route.ts:179-196` | |
| A5 | ⚠️ Sửa một phần | `totp.ts:20-83, 326-331, 417-431`, `login/route.ts:121-126` | Đã có khóa riêng. Nhưng hash recovery code dạng `v1:` vẫn dẫn xuất từ `JWT_SECRET` và không được migrate; secret chỉ được mã hóa lại khi user đăng nhập. |
| A6 | ✅ Đã sửa | `login/route.ts:26-28, 70-74` | Chạy scrypt giả với username không tồn tại. |
| A7 | ✅ Đã ghi tài liệu | `README.md:139`, `HUONG-DAN-CAI-DAT-NAS.md:72`, `.env.example:35` | |
| A8 | ✅ Đã sửa | `schedules/route.ts:10`, `volumes/route.ts:126`, `jobs/[id]/route.ts:81` | |
| ESLint | ✅ Đã sửa | `eslint.config.mjs`, CI có bước `npm run lint` | |
| Lỗi merge sót lần 2 | ✅ Đã sửa | `settings/route.ts:196-198` | `reloadCronSchedules` chỉ còn gọi một lần; key `dsm_*` đã đổi thành `worm_*`. |

Bảng RBAC trong `server.ts` khớp với các route. Các route mới (`volumes/snapshot`,
`servers/[id]/host-key`, `settings/digest`, `audit-logs`) rơi vào mặc định chỉ ADMIN, và route
nào cũng tự gọi `requireRole(['ADMIN'])`.

## Phát hiện mới

### Bảo mật: shell, SSH, dữ liệu từ VPS

| # | Mức | Vị trí | Kịch bản lỗi | Đề xuất sửa |
|---|---|---|---|---|
| S12 | **Cao** | `sql-stream-guard.ts:33, 64, 68-76, 151-152, 171, 223, 287-291, 322-326` | Dump của VPS A bị chiếm được restore sang VPS B có psql thiếu `\restrict` (PG < 17.6 / 16.10 / 15.14 / 14.19 / 13.22), và `\!` chạy shell dưới user `postgres` trên B. Các payload là SQL hợp lệ (nên `ON_ERROR_STOP` không chặn được) mà guard cho qua nguyên vẹn, cả khi đưa cả khối lẫn từng byte một:<br>(1) `SELECT 1 AS "COPY x FROM stdin";` làm guard tưởng đang ở chế độ COPY.<br>(2) `-- x\r\! id`: guard chỉ kết thúc comment ở `\n`, còn psql kết thúc ở cả `\r`.<br>(3) `CREATE TABLE a$$x$ …` khiến guard đọc nhầm thành mở dollar-quote.<br>(4) `SET standard_conforming_strings = off` lọt vì string literal bị thu gọn trước khi chạy regex.<br>(5) `client_encoding = 'SJIS'` có byte `0x5c` nằm trong ký tự multibyte.<br>(6) `a$E'\'`.<br>Ngoài ra `\restrict` có trong dump bị xóa đi (dòng 151-152). Phía guard đã xác nhận bằng cách chạy thật; phía psql suy ra từ `psqlscan.l`, *cần xác nhận với psql thật*. | Không dựa vào lexer tự viết. Từ chối restore PostgreSQL khi đích không có `\restrict`, hoặc chuyển sang `pg_dump -Fc` + `pg_restore`. Kết nối bằng role của khách thay vì `postgres` + `SET SESSION AUTHORIZATION`. Nếu giữ guard: từ chối `\r`, `client_encoding` khác UTF8, mọi nhắc tới `standard_conforming_strings` / `session_authorization`, và không giữ text trong quoted identifier khi so khớp COPY. Bỏ câu "chặn 100%" trong comment. |
| S13 | **Cao** (regression) | `restore-worker.ts:175`, `base.ts:45-50` | Lệnh là `mysql --binary-mode ${authFlags}`. Khi `authFlags` là `--defaults-extra-file=…`, option này không còn đứng đầu, nên client báo `unknown variable 'defaults-extra-file=…'` và thoát với mã 7 (đã chạy thử với mysql 8.0.30; MariaDB *cần xác nhận*). Hệ quả: **mọi restore MySQL thất bại** trên cPanel và trên HestiaCP/CyberPanel/CloudPanel khi dùng `.my.cnf` / `debian.cnf`. Lỗi theo hướng an toàn nhưng làm mất tính năng restore. Đã tự đọc code để xác nhận. | `mysql ${authFlags} --binary-mode …`. Thêm test kiểm tra thứ tự cờ. |
| S14 | Trung bình | `restore-worker.ts:72-81`, `rsync-runner.ts:133-144` | Restore push bằng `-az` dưới quyền root, giữ nguyên owner và bit setuid/setgid từ snapshot. Khi NAS chạy root (`RUN_AS_ROOT`, hoặc volume cũ do root sở hữu), VPS nguồn bị chiếm có thể cài binary setuid-root cùng một file PHP kích hoạt vào `public_html`. Sau restore chéo server, binary đó giữ quyền setuid root cho tới khi `chown -hR` chạy (tới 15 phút), hoặc mãi mãi nếu chown lỗi (chỉ log warning), tức là có root trên VPS đích. | Thêm `--no-o --no-g --chmod=ugo-s` khi push và pull, và/hoặc chạy rsync phía remote bằng user site. |
| S15 | Thấp | `restore-worker.ts:587-603`, `base.ts:69-86` | Fallback root `mkdir -p -- "$TARGET"` đi theo symlink ở các thành phần trung gian của path, nên có thể tạo thư mục rỗng của root ở ngoài jail trước lần kiểm tra thứ hai (*cần xác nhận*). | Bỏ fallback root, hoặc tạo từng đoạn path và kiểm tra symlink ở mỗi đoạn. |
| S16 | Thấp | `ssh.ts:709-732, 773-789` | Không đặt `GlobalKnownHostsFile=/dev/null`, nên key của IP đó trong `/etc/ssh/ssh_known_hosts` của container cũng được chấp nhận song song với key đã pin (*cần xác nhận*). | Đặt `GlobalKnownHostsFile=/dev/null`. |
| S17 | Thấp / Trung bình | `worm-snapshot.ts:83, 191-214, 248-267` | Snapshot TrueNAS được tạo với `recursive: true`, nhưng hold chỉ đặt trên ID cha, nên snapshot của dataset con nhiều khả năng không được hold. Cùng một API key vừa nhả hold vừa xóa được snapshot, nên ai chiếm được NAS-Sync là xóa được bản "WORM". Response list trên 2 MB thì bước dọn hết hạn bị bỏ qua mà không báo (*cần xác nhận với API TrueNAS*). | Hold đệ quy. Dùng key chỉ có quyền tạo snapshot và đặt hold, còn việc hết hạn để NAS tự xử lý. |

### Bảo mật: updater, release, cài đặt

| # | Mức | Vị trí | Kịch bản lỗi | Đề xuất sửa |
|---|---|---|---|---|
| U6 | **Cao** | `release.yml:3-6, 58-80` | `RELEASE_SIGNING_PRIVATE_KEY` là secret thường của repo, được dùng cho mọi tag `v*.*.*` push lên bất kỳ commit nào: không có environment cần duyệt, không kiểm tra nhánh. Ai có quyền push (hoặc PAT có `contents:write` bị lộ) chỉ cần push `v9.9.9` trên một commit độc là CI ký, và mọi NAS cài nó với nhãn "Ed25519 verified". Đây chính là rủi ro của U1, chỉ đổi đường từ `main` sang tag. | Đưa secret vào GitHub Environment có required reviewers. Bật tag protection. Kiểm tra commit của tag nằm trên `main`. Tốt nhất là ký offline hoặc bằng khóa phần cứng. |
| U7 | **Cao** | `release.yml:30-36, 44-56, 90-105` | Job build chạy `npm ci` có lifecycle script. Một dependency độc (kể cả devDependency) có thể sửa `.next` hoặc `src` trước khi đóng gói. Job publish tính lại SHA từ artifact rồi ký, nên chữ ký "hợp thức hóa" bản build đã bị chiếm. | `npm ci --ignore-scripts` ở job build, tách bước đóng gói khỏi bước install. Cân nhắc thêm build provenance attestation. |
| U8 | Trung bình | `updater.ts:28-41`, `docker-entrypoint.sh:74`, `package-prebuilt.mjs:43` | `docker-entrypoint.sh` có trong tarball prebuilt nhưng không bao giờ được chép vào image đang chạy. Bản cài từ image cũ rồi cập nhật qua UI vẫn chạy entrypoint cũ (chạy root, còn lỗi E1), trong khi UI báo v1.7.0 kèm đủ bản sửa. | Cảnh báo "cần pull hoặc rebuild image" khi hash entrypoint khác, hoặc thêm kiểm tra `minImageVersion`. |
| U9 | Trung bình | `update.sh:67-90`, `release.yml:113-117` | Script `update.sh` chạy root trên host rồi `docker compose up --build`, và dùng `nas-sync-bundle.tar.gz` không có chữ ký. Nếu tải `.sha256` lỗi hoặc file rỗng, script bỏ qua bước kiểm tra mà không báo (dòng 71, 78). Nếu tải bundle lỗi, nó kéo `codeload …/refs/tags/<tag>` không kiểm tra gì (dòng 87). | Ký cả bundle và kiểm tra trong `update.sh`. Fail-closed khi thiếu sha hoặc sig. Bỏ fallback codeload. |
| U10 | Trung bình | `updater.ts:641-671, 1338-1342`, `docker-entrypoint.sh:20-21, 42` | Updater chỉ nhận ra thay đổi dependency qua `package.json.dependencies`. Thay đổi chỉ trong lockfile (bản vá bảo mật transitive, hoặc patch của next / socket.io trong cùng range `^`) không bao giờ được cài, nên `.next` build ở CI chạy với `node_modules` khác phiên bản. | So hash `package-lock.json` và chạy `npm ci` trong staging khi khác. |
| U11 | Trung bình | `package-release.mjs:145-149`, `install.sh:86-105` | Bundle release đã có sẵn `.env` (copy từ `.env.example`), nên `[ ! -f ./.env ]` trong `install.sh` luôn false và cả khối setup không chạy. Hệ quả: `SANDBOX_DB_PASSWORD` giữ mặc định `sandbox_secret_pass`, không sinh `TOTP_ENCRYPTION_KEY`, không dò `NAS_VOL1_PATH` theo nền tảng, không lấy PUID từ `SUDO_UID`. Trên TrueNAS/QNAP, thư mục backup `/volume1/VPS_Backups` bị tạo trên ổ hệ điều hành thay vì pool. Đã tự đọc code để xác nhận. | Không đóng `.env` vào bundle, hoặc để `install.sh` nhận ra `.env` chưa sửa bằng cách so với `.env.example`. |
| U12 | Thấp / Trung bình | `docker-compose.yml:39-77`, `.env.example:24-37, 57` | Compose không có `env_file:`, và `environment:` không truyền `GITHUB_TOKEN`, `TOTP_ENCRYPTION_KEY`, `TRUST_PROXY`, `FORCE_RESET_ADMIN_PASSWORD`, `FORCE_RESET_ADMIN_2FA`. Đặt các biến này trong `.env` (như tài liệu hướng dẫn) không có tác dụng. | Truyền rõ từng biến đã ghi trong tài liệu; tránh `env_file` toàn bộ để không lọt `ALLOW_UNVERIFIED_MAIN_UPDATE`. |
| U13 | Thấp | `updater.ts:1146, 1194-1202, 1321`, `release-signature.ts:41` | Không chống hạ cấp: với `force: true`, updater cài bản `releases/latest` chỉ tới ngay cả khi bản đó cũ hơn bản đang chạy. v1.6.0 cũng có chữ ký hợp lệ (đã kiểm tra trên release thật). | Yêu cầu `compareSemver(relVer, local) >= 0` trừ khi chọn rollback rõ ràng; có thể ghi lại version cao nhất đã cài. |
| U14 | Thấp | `updater.ts:1602-1606, 1662-1668` | (a) Nếu `syncReleaseDirToAppRoot` lỗi sau khi đã rename `staging → current`, catch khôi phục `/app` nhưng giữ `current` mới, nên lần restart sau entrypoint vẫn áp bản cập nhật "lỗi" đó. (b) Catch luôn rm + cp từ `previous` đè lên `/app` kể cả khi `/app` chưa bị đụng tới. | Theo dõi cờ `appRootTouched`; khi lỗi thì đưa `current` về chỗ cũ hoặc xóa đi. |
| U15 | Thấp | `updater.ts:1491-1524` | Chỉ ở kênh dev: khi dependency không đổi, `node_modules` của staging symlink tới `/app/node_modules` đã bị prune devDependencies, nên `next build` sẽ lỗi (*cần xác nhận*). | Luôn `npm ci --include=dev` trong staging cho kênh dev. |
| U16 | Thấp | `sign-release.mjs:81`, `release.yml:85`, `release-signature.ts:9-11` | Workflow không dùng `sign-release.mjs` mà chép lại logic inline. Script có lối tắt `SKIP_DEFAULT_PUBKEY_CHECK`. Public key bị chép ở 3 nơi, nên dễ lệch nhau. | Workflow gọi đúng một script, và script lấy key từ một nguồn duy nhất. |
| O7 | Thấp | `offsite-cloud.ts:229-246, 554` | Phân giải DNS để kiểm tra xong thì `fetch` phân giải lại lần nữa, nên DNS rebinding vẫn tới được IP nội bộ (chỉ ADMIN cấu hình được). | Ghim IP đã kiểm tra bằng `lookup` / `connect` tùy biến của undici. |
| E2 | Thấp | `docker-entrypoint.sh:118` | Entrypoint `chown -R /app` bằng root mỗi lần boot, trong khi `/app` cho user app ghi. Nếu host đặt `fs.protected_hardlinks=0`, user app có thể hardlink `/etc/passwd` vào `/app` và được chown ở lần boot sau (*cần xác nhận theo sysctl của host*). | Chỉ chown lần đầu, hoặc `find -user 0 ! -links +1`. |

### Độ tin cậy: hàng đợi, job, mất dữ liệu

| # | Mức | Vị trí | Kịch bản lỗi | Đề xuất sửa |
|---|---|---|---|---|
| N18 | **Cao** | `queue.ts:620, 844` so với `backup-worker.ts:774-808`, `queue.ts:372-375` | BullMQ có `attempts: MAX_BACKUP_RETRIES` (10), trong khi worker cho retry khi `nextRetry <= 10`. Lần thử thứ 10 lỗi: worker set INTERRUPTED rồi throw, còn BullMQ đã hết lượt nên chuyển job sang failed. Trong DB, job nằm im ở INTERRUPTED: không có cảnh báo CRITICAL, digest không đếm, và chỉ thành FAILED ở lần restart container sau (`queue.ts:572-606`). Hệ quả là N4 cũ vẫn còn ở BullMQ mode: VPS offline làm mất backup đêm đó mà không ai biết. Đã tự đọc code để xác nhận. | `attempts = MAX + 1`, hoặc kiểm tra `attemptsMade + 1 >= opts.attempts` (hoặc thêm `worker.on('failed')`) để chuyển FAILED và gửi CRITICAL. Thống nhất ngưỡng `<=` / `>=` với logic lúc khởi động (`queue.ts:577, 682`). |
| N19 | Trung bình | `queue.ts:505-512, 561-567`, `backup-worker.ts:229, 570-574` | Container restart khi job đang VERIFYING, lúc snapshot đã được rename vào chỗ. Khi khởi động, job bị chuyển sang INTERRUPTED rồi chạy lại: xóa `backup_items` của job, pull full lại, rồi đến lúc commit thì `rmSync` snapshot tốt. Nếu lần chạy lại lỗi không retry được, job thành FAILED và không còn item nào: snapshot vẫn nằm trên đĩa nhưng không restore được, và retention cũng không dọn. | Khi khởi động, nếu thư mục snapshot cuối đã tồn tại thì đánh COMPLETED với item UNTESTED thay vì chạy lại. |
| N20 | Trung bình | `backup-worker.ts:337, 774`, `extended-hosting-backup.ts:614, 673` | Admin hủy backup vì VPS không kết nối được. `execRemoteSSH` đang chạy (không đăng ký cancel) trả về 255 và ném `RetryableNetworkError`. Nhánh retry không kiểm tra `isJobCancelled`, nên job chuyển sang INTERRUPTED và tự resume sau 1–30 phút. | Thêm `&& !isJobCancelled(jobId)` ở dòng 774. |
| N21 | Trung bình | `sandbox-verifier.ts:101-126, 790-795, 902-908` | Mỗi lần verify đều `ALTER USER nas_sync_verifier … IDENTIFIED BY <random>`. Hai backup của hai server verify cùng lúc (concurrency 3, lock theo server), hoặc `verify_sandbox` thủ công trùng với verify ban đêm: job B đổi mật khẩu, nên các lần spawn `mariadb` tiếp theo của job A bị "Access denied". Các DB đó bị đánh CORRUPTED và phát cảnh báo. | Mỗi job một user riêng (`verifier_<jobId>`), hoặc mutex toàn tiến trình bao quanh bước tạo credential và cả quá trình verify. |
| N22 | Trung bình | `restore-worker.ts:357-390` | Các kiểm tra đầu vào ném lỗi *trước* khối `try` có ghi FAILED, trong khi `processJobPayload` đã claim job sang RUNNING. Ví dụ: server đích đã bị xóa (`target_server_id` thành NULL nhưng `restore_options.targetServerId` vẫn còn), item không còn, hoặc JSON `restore_options` hỏng. Restore kẹt ở RUNNING tới lần restart sau, không có cảnh báo. | Đưa các kiểm tra vào trong `try`, hoặc để `processJobPayload` chuyển FAILED khi status vẫn là RUNNING sau lỗi. |
| N23 | Trung bình (*cần xác nhận khi chạy thật*) | `retention-gfs.ts:239`, `jobs/[id]/route.ts:348`, `worker-state.ts:196`, `backup-worker.ts:572` | `fs.rmSync` đồng bộ xóa cả snapshot hard-link nhiều triệu file trên HDD có thể chặn event loop hơn 30s (mặc định `lockDuration` của BullMQ). Stalled checker giao lại các job đang chạy; claim từ chối bản trùng nhưng BullMQ coi job đã xong, nên retry hoặc fail sau đó của lần chạy gốc gặp lỗi "Missing lock", và job kẹt ở INTERRUPTED. | Dùng `fs.promises.rm` hoặc spawn `rm -rf`; nâng `lockDuration`. |
| N24 | Thấp / Trung bình | `queue.ts:139-152, 427-436`, `schedules/retention/route.ts:63` | Ở Local mode, hàm nhả lock không gọi `drainLocalQueue()`. Backup được enqueue trong lúc retention thủ công đang giữ lock sẽ nằm ở QUEUED cho tới khi có job khác xong hoặc được enqueue. | Gọi `drainLocalQueue()` qua `setImmediate` khi nhả lock. |
| N25 | Thấp | `servers/[id]/route.ts:244` | Xóa server không kiểm tra job đang chạy: cascade xóa row job, nhưng worker vẫn ghi tiếp ra thư mục không ai quản lý. Snapshot cũ nằm trên đĩa mãi mãi, và nếu thêm lại server cùng hostname thì nó thừa hưởng `latest` cũ. | Trả 409 khi còn job đang chạy; hỏi người dùng giữ hay xóa thư mục host. |
| N26 | Thấp | `queue.ts:298-306, 399-402, 751-756, 984-996` | WORM batch kích hoạt quá sớm: khối `finally` gỡ job khỏi batch ngay cả khi job sẽ retry. Với khoảng cách enqueue 1,5s, job đầu có thể xong (fail nhanh) trước khi job thứ hai được enqueue, làm batch rỗng và WORM chạy hai lần. | Chỉ gỡ khỏi batch khi job ở trạng thái kết thúc; đăng ký mọi jobId của batch trước khi dispatch. |
| N27 | Thấp | `jobs/[id]/route.ts:160-162`, `queue.ts:861`, `worker-state.ts:115-117` | Hủy một job đã xong để lại cờ cancel vĩnh viễn. Lần `verify_sandbox` sau trên job đó kill mọi lượt import trong 3s và đánh mọi item CORRUPTED. | Từ chối cancel với job đã kết thúc, hoặc xóa cờ cancel trong `verify_sandbox`. |
| N28 | Thấp | `ssh.ts:802-853`, `restore-worker.ts:657`, `volume-manager.ts:619-623`, `sandbox-verifier.ts:899, 918` | `execRemoteSSH` / `execLocalCommand` không đăng ký cancel, nên `chown` khi restore (tới 15 phút) và rsync seed volume (tới 1 giờ) không hủy được. `conn.query` của sandbox không có timeout, nên container sandbox treo có thể giữ job ở VERIFYING cùng lock server (*phần sau cần xác nhận*). | Đăng ký process vào cơ chế cancel; đặt query timeout. |
| N29 | Thấp | `sql-stream-guard.ts:372-376`, `sandbox-verifier.ts:709, 751` | Giới hạn 64 MiB mỗi dòng áp dụng cả trong dữ liệu COPY. Dòng bytea hợp lệ lớn hơn khoảng 32 MiB (khi mã hóa hex) bị từ chối lúc restore và bị đánh CORRUPTED khi verify. | Bỏ giới hạn ở trạng thái COPY_DATA, hoặc stream dòng đó qua. |

### Auth, API, RBAC

| # | Mức | Vị trí | Kịch bản lỗi | Đề xuất sửa |
|---|---|---|---|---|
| A9 | Trung bình | `users/[id]/route.ts:102-138, 157-165` | ADMIN gửi `PATCH /api/users/<id của mình>` với `{"reset2fa": true, "password": "…"}` mà không phải nhập mật khẩu hiện tại hay TOTP, tức là bỏ qua bước xác thực lại mà `auth/2fa` (`2fa/route.ts:246-282`) và `auth/me` (`me/route.ts:53-92`) yêu cầu. Ai cầm cookie admin bị lộ là gỡ được 2FA, đặt mật khẩu mới và đá admin thật ra. Reset admin khác cũng không cần xác thực lại. Lỗi có từ `81dbf5b` nhưng lần 2 bỏ sót. | Khi `targetId === session.userId`, từ chối `password` / `reset2fa` và chuyển sang route tự phục vụ. Yêu cầu mật khẩu (và TOTP) của admin trước khi reset người khác. |
| A10 | Trung bình | `jobs/[id]/route.ts:128, 165-223`, `server.ts:176` | Tạo restore chỉ dành cho ADMIN (`restore/route.ts:52`), nhưng OPERATOR có thể `PATCH {action: "retry"}` một job **RESTORE** đã FAILED hoặc CANCELLED để chạy lại. Ví dụ: admin hủy một lệnh restore nhầm snapshot cũ vào production, rồi operator bấm retry và ghi đè file cùng DB production. Retry không ghi audit log. | Bắt buộc ADMIN khi `job_type === 'RESTORE'`; ghi audit cho retry, cancel, pin và unpin. |
| A11 | Trung bình | `db.ts:649-695`, `settings/route.ts:20-32, 209-215`, `settings/page.tsx:281, 531-535` | Migration v1.7 copy `dsm_password` sang `worm_password` nhưng không xóa các row `dsm_*` cũ, mà `dsm_password` không còn trong `SECRET_SETTING_KEYS`. Trên mọi bản nâng cấp từ ≤ 1.6 có cấu hình DSM, `GET /api/settings` trả **mật khẩu admin NAS dạng plaintext**, React state giữ nó và gửi lại mỗi lần lưu. Tên key được ghép bằng `['d','s','m_'].join('')`, nên grep `dsm_` không tìm thấy. Đã tự đọc code để xác nhận. | Xóa các row `dsm_*` sau khi migrate, và để GET chỉ trả các key nằm trong allowlist. |
| A12 | Thấp | `2fa/route.ts:102, 139, 256, 352`, `me/route.ts:83` | Bước kiểm tra mật khẩu hiện tại (và TOTP khi tắt 2FA hay sinh lại recovery code) không có throttle. Ai có session là dò mật khẩu online không giới hạn được. | Dùng lại `login-throttle`, khóa theo userId. |
| A13 | Thấp | `login-throttle.ts:53-58`, `password.ts:22` | Store giữ tối đa 5000 entry và loại entry cũ nhất. Từ một IP, gửi khoảng 5000 lần login sai với username ngẫu nhiên là đẩy được chính record `IP\|admin` đang bị khóa ra khỏi store. Mỗi lần thử còn chạy scrypt đồng bộ, gây DoS CPU mà không cần xác thực. | Đếm riêng theo IP và không bao giờ loại entry đang bị khóa. Dùng `crypto.scrypt` async. |
| A14 | Thấp | `totp.ts:51-65` | `.totp_secret` có nhưng không đọc được thì code fallback sang khóa ngẫu nhiên trong RAM. File ngắn hơn 32 ký tự thì code ghi đè file. Kết quả: secret 2FA mới được mã hóa bằng khóa mất đi sau khi restart, và secret cũ không giải mã được, nên user có 2FA bị khóa ngoài. | Fail-closed (throw), không bao giờ ghi đè file khóa đã có. |
| A15 | Thấp | `me/route.ts:126-128`, `users/route.ts:78-80`, `db.ts:117` | Tự đổi username chỉ so sánh phân biệt hoa thường, trong khi tạo user dùng `LOWER()`. VIEWER đổi tên thành `Admin` song song với `admin`, gây nhầm trong danh sách user và audit log. | Kiểm tra bằng `LOWER()` và đặt `COLLATE NOCASE` cho cột. |
| A16 | Thấp | `volumes/snapshot/route.ts:5-13`, `worm-snapshot.ts:571-573` | Route mới không có try/catch và không ghi audit log, lại trả nguyên văn lỗi (có thể chứa URL hoặc IP nội bộ) với HTTP 500. | Thêm audit log và cho lỗi đi qua `sanitizeErrorMessage`. |
| A17 | Thấp | `jobs/route.ts:16` | `?limit=-1` thành `LIMIT -1` của SQLite, tức là không giới hạn, nên VIEWER dump được mọi job. `?limit=abc` cho ra NaN, mà handler không có try/catch. | `Math.max(1, …)` và kiểm tra `Number.isFinite`. |
| A18 | Thấp | `schedules/*`, `volumes/*`, `servers/[id]/test`, `jobs/[id]/route.ts:147-163` | Các thao tác ghi này không có `recordAuditLog`. OPERATOR unpin snapshot không để lại dấu vết, và lần retention GFS sau có thể xóa luôn snapshot đó. | Ghi audit cho các mutation; cân nhắc chỉ cho ADMIN unpin. |

## Lỗi merge và code thừa

- Không có conflict marker, không có dòng lặp hay dấu ngoặc thừa. Commit `b8ddd67` đã dọn phần
  ngoặc thừa từ buffer IDE.
- `git diff --check` báo dòng trống thừa cuối file ở `eslint.config.mjs:56`,
  `scripts/sign-release.mjs:96` và `src/lib/release-signature.ts:89`. Ngoài ra khoảng 22 file
  khác trong `src` cũng thừa dòng trống cuối file (chỉ là thẩm mỹ).
- Code chết hoặc thừa:
  - `base.ts:159-163`: khối `if … then : fi` rỗng.
  - `ssh.ts:578`: biến `lowerWithoutPub` không dùng tới.
  - `backup-worker.ts:86, 101-107`: set lại status sau khi đã claim.
  - `queue.ts:322-324`: early return cho RESTORE bị thừa.
- `aapanel.ts:186`: `find . -P` trông như một chỗ sửa chưa được chạy thử (xem S9).
- Comment "chặn đứng 100%" ở `sandbox-verifier.ts:146`, `restore-worker.ts:174` và
  `sql-stream-guard.ts:82-86` là sai với PostgreSQL (S12).
- `migrateLegacyVolumeLabelsAndWormSettings` chạy 2 lần mỗi lần khởi động. Không gây hại.

## Kiểm tra đã chạy

- `git fetch`, rồi merge `origin/main` (`75563a8`) vào `wnreview` bằng merge commit, không cần
  force-push.
- Chạy cục bộ đúng các lệnh CI (`.github/workflows/ci.yml`), Node 24.14.1, Windows. Tất cả pass:
  - `npm ci`
  - `npm run lint`: 0 lỗi.
  - `npm run typecheck`
  - `npm test`: 29/29 test qua 3 file test (8 suite + 10 test top-level).
  - `npm run build`
- `git diff --check 81dbf5b origin/main`: chỉ báo 3 dòng trống thừa cuối file.
- Đã chạy thử:
  - `sql-stream-guard.ts` trên Node 24 với từng payload, đưa cả khối lẫn từng byte một: kết quả
    giống nhau, nên ranh giới chunk không phải điểm yếu. 6 payload ở S12 lọt qua; `\!` trần, `\`
    sau `;` và `COPY … PROGRAM` ở cấp ngoài cùng bị chặn.
  - mysql 8.0.30 với `--binary-mode --defaults-extra-file=…`: lỗi `unknown variable` (S13).
  - `git ls-remote`: cả 9 SHA action đã pin trong `release.yml` / `ci.yml` khớp với tag ghi kèm.
  - `verifyReleaseSignature` trên `.sha256` / `.sig` thật của v1.6.0 và v1.7.0: cả hai hợp lệ với
    public key nhúng sẵn (vì thế U13 có mục tiêu hạ cấp thật).
  - Không thấy private key nào khớp với public key trong repo hay lịch sử git.
  - NASSYNC2: mã hóa rồi giải mã đúng; bỏ frame EOF hoặc lật bit header đều bị phát hiện. File
    NASSYNC1 tạo bằng bộ mã hóa của `81dbf5b` giải mã được bằng cả thư viện lẫn CLI mới.
- Đã tự đọc code để xác nhận: S9, S13, U11, N18, A11.
- **Chưa test được:**
  - psql thật, có và không có `\restrict` (S6, S12).
  - VPS thật chạy cPanel/DirectAdmin/CyberPanel/aaPanel.
  - MariaDB client (S13).
  - BullMQ/Redis thật (N18, N23).
  - API TrueNAS (S17).
  - Restore DB lớn (N5, N11).

## Đề xuất thứ tự xử lý

1. **S13:** đổi thứ tự cờ, sửa một dòng là khôi phục restore MySQL cho cPanel và các panel khác.
2. **S9:** `find -P .`, sửa một dòng.
3. **S12, S6:** từ chối restore PostgreSQL khi psql đích không có `\restrict`, hoặc chuyển sang
   `pg_restore`; kết nối bằng role của khách.
4. **N18:** thống nhất số lần retry giữa BullMQ và worker để lần thử cuối có FAILED và CRITICAL.
5. **U6, U7:** environment có duyệt cho khóa ký, tag protection, và `npm ci --ignore-scripts`.
6. **A11, U11, A9, A10:** rò mật khẩu DSM, `.env` trong bundle, và hai đường bỏ qua quyền.
7. **S14, N19–N22, U8–U10:** setuid khi restore, job chạy lại hoặc kẹt, cập nhật không đầy đủ.
8. Các mục Thấp còn lại.
