# HƯỚNG DẪN CÀI ĐẶT, GẮN PHÂN VÙNG, TRỎ TÊN MIỀN HTTPS & CẬP NHẬT `NAS-SYNC` ĐA NỀN TẢNG NAS

Kho mã nguồn chính thức: **<https://github.com/shostwp-byte/nas-sync>** (Giấy phép miễn phí **MIT License**).

Tài liệu này áp dụng cho mọi thiết bị NAS hỗ trợ Docker (**TrueNAS SCALE, QNAP QTS/QuTS hero, UGREEN NASync, TerraMaster TOS, Asustor ADM, Unraid, OpenMediaVault**) cũng như các máy chủ lưu trữ **Ubuntu / Debian / Proxmox**.

---

## PHẦN 1: Chuẩn bị Thư mục Sao lưu & Quyền `PUID` / `PGID` trên NAS

Để dữ liệu sao lưu nằm bền vững trên ổ cứng vật lý và hỗ trợ đầy đủ **POSIX Hard-Link (`rsync --link-dest`)**:

1. **Tạo thư mục lưu trữ trên phân vùng ổ cứng nội bộ của NAS** (`ZFS`, `Btrfs`, `Ext4` hoặc `XFS`):
   * **TrueNAS SCALE**: Tạo Dataset mới (VD: `/mnt/tank/vps_backups`).
   * **QNAP (QTS / QuTS hero)**: Tạo Shared Folder (VD: `/share/CACHEDEV1_DATA/VPS_Backups` hoặc `/share/ZFS1_DATA/VPS_Backups`).
   * **UGREEN / Asustor / NAS dùng `/volume1`**: Tạo Shared Folder `/volume1/VPS_Backups`.
   * **TerraMaster TOS**: Tạo Shared Folder `/Volume1/VPS_Backups`.
   * **Unraid**: Tạo Share ưu tiên gắn trên Cache/Disk trực tiếp (`/mnt/cache/vps_backups` hoặc `/mnt/disk1/vps_backups`) để đạt tốc độ tạo Hard-Link cao nhất.
   * **OpenMediaVault / Linux**: Tạo thư mục `/srv/dev-disk-by-uuid-.../vps_backups` hoặc `/opt/nas-sync/backups`.
2. **Xác định `PUID` và `PGID`** (nếu không dùng trình cài đặt tự động `install.sh`):
   * Đăng nhập SSH vào NAS và gõ `id` để xem `uid=` và `gid=` của tài khoản quản trị sở hữu thư mục sao lưu, sau đó điền vào biến `PUID` và `PGID` trong tệp `.env`.

---

## PHẦN 2: Triển khai Ứng dụng `NAS-Sync`

### Cách 1: Cài đặt tự động 1 lệnh qua SSH (Khuyên dùng — Nhanh & Chính xác nhất)

```bash
git clone https://github.com/shostwp-byte/nas-sync.git
cd nas-sync
sudo bash install.sh
```

*(Nếu NAS chưa cài `git`, bạn có thể tải gói `nas-sync-bundle.tar.gz` từ trang Releases, giải nén `tar -xzf nas-sync-bundle.tar.gz` rồi chạy `cd nas-sync && sudo bash install.sh`).*

### Cách 2: Cài đặt bằng Giao diện Quản lý Docker trên Web của NAS

1. Tải gói **`nas-sync-bundle.zip`** từ [GitHub Releases](https://github.com/shostwp-byte/nas-sync/releases) và giải nén vào thư mục chứa ứng dụng Docker trên NAS (thu được thư mục `nas-sync`).
2. Sao chép hoặc đổi tên tệp `nas-sync/.env.example` thành `nas-sync/.env`, sau đó cập nhật:
   * `NAS_VOL1_PATH`: Đường dẫn thư mục sao lưu thực tế bạn vừa tạo ở Phần 1.
   * `ADMIN_PASSWORD`: Mật khẩu quản trị lần đầu.
   * `PUID` / `PGID`: UID và GID có quyền đọc/ghi vào `NAS_VOL1_PATH`.
3. Mở công cụ quản lý Docker trên NAS (**QNAP Container Station -> Application**, **TrueNAS Custom App**, **UGREEN Docker -> Project**, **TerraMaster Docker**, **Portainer Stacks**, hoặc **Dockge**):
   * Chọn tạo dự án từ tệp `docker-compose.yml` có sẵn trong thư mục `nas-sync`.
   * Khởi chạy cụm 3 container (`nas_sync_core`, `nas_sync_redis`, `nas_sync_sandbox`).
4. Mở trình duyệt truy cập `http://<IP_LAN_CỦA_NAS>:3080`, sau đó vào mục **Phân vùng Lưu trữ (`/volumes`)** để xác nhận huy hiệu **`Hard-Link OK`** đã sáng xanh.

---

## PHẦN 3: Trỏ Tên miền HTTPS (SSL + WebSocket) về Thiết bị NAS

### Phương án A (Khuyên dùng — Không cần mở Port Router): Cloudflare Tunnel (`cloudflared`)

Phù hợp cho mọi mạng gia đình / doanh nghiệp dùng IP động, CGNAT hoặc sau tường lửa nội bộ:

1. Truy cập [Cloudflare Zero Trust](https://one.dash.cloudflare.com/) -> **Networks** -> **Tunnels** -> **Create a tunnel** -> chọn **Cloudflared** -> đặt tên `nas-sync-tunnel`.
2. Chọn môi trường **Docker**, sao chép `TUNNEL_TOKEN` và khởi chạy trên NAS:
   ```bash
   docker run -d \
     --name nas_sync_cloudflared \
     --restart unless-stopped \
     cloudflare/cloudflared:latest \
     tunnel --no-autoupdate run --token <DÁN_MÃ_TUNNEL_TOKEN_CỦA_BẠN>
   ```
3. Tại thẻ **Public Hostname**, trỏ tên miền (VD: `backup.domain.com`) về dịch vụ `HTTP` -> `<IP_LAN_CỦA_NAS>:3080` và nhấn **Save**.

### Phương án B: Nginx Proxy Manager / Traefik / Caddy / Reverse Proxy tích hợp trên NAS

1. Tạo Proxy Host trỏ tên miền HTTPS (`443`) về `http://<IP_NAS>:3080`.
2. **Bắt buộc bật hỗ trợ WebSocket (`Websockets Support` / Header `Upgrade` & `Connection`)** để giao diện nhận được luồng tiến trình thời gian thực `Socket.IO`.
3. **Bảo mật biến `TRUST_PROXY`**: Nếu bật `TRUST_PROXY=true` trong `.env` để ghi nhận IP thật của người dùng qua Reverse Proxy, hãy khóa tường lửa không cho truy cập trực tiếp từ Internet vào cổng `3080` (hoặc bind `127.0.0.1:3080:3000` trong `docker-compose.yml`) nhằm chống giả mạo header `X-Forwarded-For`.

---

## PHẦN 4: Cập nhật Phiên bản Mới An toàn

1. **Cập nhật 1-Click trên Giao diện Web (Đã ký số `Ed25519`)**:
   * Truy cập **Cấu hình & Cập nhật (`/settings` -> Tab `Cập nhật`)** -> nhấn **Kiểm tra bản mới** -> **Cập nhật ngay**.
2. **Cập nhật toàn bộ Docker Image qua SSH**:
   ```bash
   cd /duong-dan/nas-sync
   sudo bash update.sh
   ```
