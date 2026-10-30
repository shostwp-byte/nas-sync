# Chính sách Bảo mật (Security Policy)

Bảo mật dữ liệu sao lưu và an toàn kết nối SSH là ưu tiên tối thượng của **NAS-Sync**.

## Phiên bản Được Hỗ trợ

| Phiên bản | Trạng thái Hỗ trợ Bản vá Bảo mật |
| :--- | :--- |
| `1.1.x` | ✅ Đang được hỗ trợ tích cực |
| `< 1.1.0` | ⚠️ Khuyến nghị nâng cấp lên `1.1.0+` qua tính năng 1-Click Update |

## Nguyên tắc Thiết kế Bảo mật Cốt lõi

1. **Zero-Password SSH**: Hệ thống không lưu mật khẩu `root` của VPS, chỉ sử dụng cặp khóa bất đối xứng (`Ed25519` / `RSA 4096`) với quyền `0600`.
2. **One-Way Agentless Pull**: VPS nguồn không có thông tin xác thực của Synology NAS, ngăn chặn lây lan chéo khi VPS bị xâm nhập.
3. **No Docker Socket Exposure**: Tính năng tự cập nhật từ GitHub hoạt động độc lập trong không gian người dùng của container mà không yêu cầu mount `/var/run/docker.sock`.
4. **HttpOnly JWT & Scrypt**: Phiên đăng nhập quản trị được bảo vệ bằng chữ ký HMAC-SHA256 và băm mật khẩu `scrypt` có muối ngẫu nhiên.

## Báo cáo Lỗ hổng Bảo mật

Nếu bạn phát hiện một lỗ hổng bảo mật tiềm ẩn:
- **Vui lòng KHÔNG mở Public Issue công khai** chứa mã khai thác (PoC) ngay lập tức.
- Hãy sử dụng tính năng **Report a vulnerability (Private Security Advisory)** trực tiếp tại tab **Security** của kho lưu trữ: <https://github.com/shostwp-byte/nas-sync/security/advisories/new>.
- Chúng tôi sẽ phản hồi xác nhận trong vòng **48 giờ** và phát hành bản vá khẩn cấp sớm nhất có thể.

