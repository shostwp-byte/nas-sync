# Chính sách Bảo mật (Security Policy)

Bảo mật dữ liệu sao lưu và an toàn kết nối SSH là ưu tiên tối thượng của **NAS-Sync**.

## Phiên bản Được Hỗ trợ

| Phiên bản | Trạng thái Hỗ trợ Bản vá Bảo mật |
| :--- | :--- |
| `1.7.x` | ✅ Đang được hỗ trợ tích cực |
| `1.6.x` | ✅ Bản vá bảo mật trọng yếu |
| `< 1.6.0` | ⚠️ Khuyến nghị nâng cấp ngay lên `1.7.0+` qua tính năng 1-Click Update hoặc `update.sh` |

## Nguyên tắc Thiết kế Bảo mật Cốt lõi

1. **Zero-Password SSH & Host Key Pinning**: Hệ thống không lưu mật khẩu `root` của VPS, chỉ sử dụng cặp khóa bất đối xứng (`Ed25519` / `RSA 4096`) với quyền `0600` và khóa vân tay SSH (`StrictHostKeyChecking=yes`).
2. **One-Way Agentless Pull & Untrusted Tenant Isolation**: VPS nguồn không có thông tin xác thực của thiết bị NAS; mọi luồng nạp SQL đều khóa `--binary-mode` / Stream Guard và mọi thao tác tệp từ xa đều chống Symlink Clobber / TOCTOU.
3. **No Docker Socket Exposure & Non-Root Runtime**: Tính năng tự cập nhật từ GitHub xác thực bắt buộc chữ ký số mật mã **Ed25519** trong không gian người dùng của container mà không yêu cầu gắn `/var/run/docker.sock`.
4. **HttpOnly JWT, Scrypt & 2FA TOTP**: Phiên đăng nhập quản trị được bảo vệ bằng chữ ký HMAC-SHA256, băm mật khẩu `scrypt` có muối ngẫu nhiên và xác thực hai yếu tố `TOTP` chống phát lại.

## Báo cáo Lỗ hổng Bảo mật

Nếu bạn phát hiện một lỗ hổng bảo mật tiềm ẩn:
- **Vui lòng KHÔNG mở Public Issue công khai** chứa mã khai thác (PoC) ngay lập tức.
- Hãy sử dụng tính năng **Report a vulnerability (Private Security Advisory)** trực tiếp tại tab **Security** của kho lưu trữ: <https://github.com/shostwp-byte/nas-sync/security/advisories/new>.
- Chúng tôi sẽ phản hồi xác nhận trong vòng **48 giờ** và phát hành bản vá khẩn cấp sớm nhất có thể.
