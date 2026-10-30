# HƯỚNG DẪN UPLOAD, CÀI ĐẶT, TRỎ TÊN MIỀN & CẬP NHẬT `NAS-SYNC` TRÊN SYNOLOGY NAS

Mã nguồn chính thức: **<https://github.com/shostwp-byte/nas-sync>** (Giấy phép miễn phí **MIT License**).

---

## PHẦN 1: Upload & Cài đặt Ứng dụng lên Synology NAS

Bạn có thể chọn **1 trong 2 cách** dưới đây:

### Cách 1: Cài đặt hoàn toàn bằng Giao diện Web DSM (Không cần gõ lệnh SSH)

1. **Tạo thư mục lưu trữ Backup trên NAS**:
   * Mở **Control Panel** -> **Shared Folder** (hoặc **File Station**), tạo thư mục lưu trữ trên phân vùng ổ cứng thật của bạn, ví dụ: `/volume1/VPS_Backups`.
2. **Upload & Giải nén gói cài đặt**:
   * Mở **File Station** -> vào thư mục `/docker` -> nhấn **Upload** tải file **`nas-sync-synology.zip`** lên.
   * Nhấn chuột phải vào `nas-sync-synology.zip` -> **Extract** -> **Extract Here (Giải nén tại đây)** để thu được thư mục `/volume1/docker/nas-sync`.
   * *(Khuyên dùng)* Nhấn chuột phải vào `/docker/nas-sync/.env` -> mở bằng **Text Editor** trên DSM để đổi `ADMIN_PASSWORD`, `JWT_SECRET` và `NAS_VOL1_PATH` đúng với NAS của bạn.
3. **Khởi chạy trong Container Manager**:
   * Mở **Container Manager** -> mục **Project (Dự án)** -> nhấn **Create (Tạo)**:
     * **Project name**: `nas-sync`
     * **Path**: Chọn `/docker/nas-sync` -> chọn **Use existing docker-compose.yml to create project**.
   * Nhấn **Next** -> **Done** để Synology tự động Build Image và khởi chạy 3 container (`nas_sync_core`, `nas_sync_redis`, `nas_sync_sandbox`).

### Cách 2: Cài đặt tự động qua SSH / GitHub (Nhanh nhất)

Đăng nhập SSH vào Synology NAS và chạy:

```bash
cd /volume1/docker
git clone https://github.com/shostwp-byte/nas-sync.git
cd nas-sync && sudo bash install-synology.sh
```
*(Hoặc nếu không cài `git` trên DSM, upload `nas-sync-synology.tar.gz` vào `/volume1/docker/`, giải nén `tar -xzf nas-sync-synology.tar.gz` rồi chạy `cd nas-sync && sudo bash install-synology.sh`).*

---

## PHẦN 2: Hướng dẫn Trỏ Tên miền HTTPS (SSL + WebSocket) về Synology NAS

### PHƯƠNG ÁN A (Khuyên dùng — An toàn nhất): Trỏ tên miền qua Cloudflare Tunnel (`cloudflared`)

Phù hợp ngay cả khi mạng đặt NAS dùng **IP động, CGNAT nhà mạng hoặc nằm sau tường lửa nội bộ**, không cần mở Port Router, tự động có SSL HTTPS và hỗ trợ sẵn WebSocket (`Socket.IO`).

1. **Tạo Tunnel trên Cloudflare Zero Trust**:
   * Truy cập [Cloudflare Zero Trust](https://one.dash.cloudflare.com/) -> **Networks** -> **Tunnels** -> **Create a tunnel** -> chọn **Cloudflared** -> đặt tên `synology-nas-sync`.
2. **Cài Connector `cloudflared` lên Synology NAS**:
   * Chọn môi trường **Docker**, sao chép mã `TUNNEL_TOKEN` riêng của bạn và chạy trên NAS:
     ```bash
     sudo /usr/local/bin/docker run -d \
       --name nas_sync_cloudflared \
       --restart unless-stopped \
       cloudflare/cloudflared:latest \
       tunnel --no-autoupdate run --token <DÁN_MÃ_TUNNEL_TOKEN_CỦA_BẠN_VÀO_ĐÂY>
     ```
3. **Khai báo Public Hostname**:
   * Chuyển sang thẻ **Public Hostname** -> **Add a public hostname**:
     * **Subdomain**: `backup` (hoặc tên tùy chọn)
     * **Domain**: Tên miền của bạn
     * **Service Type**: `HTTP`
     * **URL**: `<IP_LAN_CỦA_NAS>:3080` *(Ví dụ: `192.168.1.10:3080`)*
   * Nhấn **Save hostname**.

### PHƯƠNG ÁN B: Synology Reverse Proxy + Let's Encrypt SSL (Khi có IP Tĩnh / DDNS)

1. Trỏ bản ghi DNS `A` (hoặc `CNAME` DDNS) của tên miền về IP Public của NAS và NAT Port `80`, `443` trên Router về IP LAN của NAS.
2. Trên DSM, vào **Control Panel** -> **Login Portal** -> **Advanced** -> **Reverse Proxy** -> **Create**:
   * **Source**: Protocol `HTTPS`, Hostname `<ten-mien-cua-ban>`, Port `443`, bật **Enable HSTS**.
   * **Destination**: Protocol `HTTP`, Hostname `127.0.0.1`, Port `3080`.
3. **Bật WebSocket (Bắt buộc để chạy thanh tiến trình Realtime)**:
   * Chuyển sang tab **Custom Header** -> nhấn mũi tên cạnh **Create** -> chọn **WebSocket** (DSM tự thêm `Upgrade` và `Connection`) -> nhấn **Save**.
4. Vào **Control Panel** -> **Security** -> **Certificate** -> **Add** -> **Get a certificate from Let's Encrypt** và gán chứng chỉ cho Reverse Proxy vừa tạo.

---

## PHẦN 3: Hướng dẫn Cập nhật Phiên bản Mới từ GitHub

1. **Cập nhật 1-Click ngay trên Giao diện Web**:
   * Mở trang quản trị **NAS-Sync** -> vào mục **Cấu hình & Cập nhật (`/settings`)**.
   * Nhấn nút **Kiểm tra bản mới** -> nhấn **Cập nhật ngay** để hệ thống tự động sao lưu CSDL, kéo bản mới nhất từ `https://github.com/shostwp-byte/nas-sync`, biên dịch an toàn và tự khởi động lại.
2. **Cập nhật toàn diện Docker Image qua SSH (Tùy chọn)**:
   ```bash
   cd /volume1/docker/nas-sync
   sudo bash update-synology.sh
   ```
