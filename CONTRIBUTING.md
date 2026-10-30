# Hướng dẫn Đóng góp (Contributing to NAS-Sync)

Cảm ơn bạn đã quan tâm và đóng góp cho dự án mã nguồn mở **NAS-Sync** (<https://github.com/shostwp-byte/nas-sync>)!

## 1. Môi trường Phát triển

- **Node.js**: `>= 22.5` (Khuyến nghị `Node.js 24 LTS` để sử dụng module `node:sqlite` tích hợp sẵn không cần biên dịch C++).
- **Hệ điều hành**:
  - Phát triển giao diện & kiểm thử mô phỏng (Mock Mode): Chạy trực tiếp trên Windows / macOS / Linux.
  - Kiểm thử luồng SSH/Rsync/Zstd thực tế: Chạy qua Docker Compose hoặc Synology Container Manager.

```bash
git clone https://github.com/shostwp-byte/nas-sync.git
cd nas-sync
npm install
npm run dev
```

## 2. Quy chuẩn Mã nguồn

- Toàn bộ mã nguồn viết bằng **TypeScript strict mode** (`npm run typecheck` phải trả về 0 lỗi).
- Tất cả các câu lệnh thực thi từ xa qua SSH trên VPS trong thư mục `src/lib/engine/adapters/` bắt buộc phải:
  1. Bọc qua cơ chế **Zero-Impact** (`wrapZeroImpact` / `ionice -c 2 -n 7 nice -n 19`).
  2. Escape tham số bằng `shellSingleQuote` để chống lỗi ký tự đặc biệt và Command Injection.
  3. Không ghi file `.sql` hoặc `.tar.gz` tạm lên ổ cứng của VPS nguồn.
- Giữ chuẩn ký tự xuống dòng **LF** cho mọi file `.sh`, `Dockerfile`, `.yml` (đã được tự động hóa qua `.gitattributes` và `.editorconfig`).

## 3. Quy trình Tạo Pull Request

1. Fork kho lưu trữ `shostwp-byte/nas-sync` và tạo nhánh tính năng mới từ `main` (`git checkout -b feat/ten-tinh-nang` hoặc `fix/ten-loi`).
2. Thực hiện thay đổi và kiểm tra biên dịch cục bộ:
   ```bash
   npm run typecheck
   npm run build
   ```
3. Commit theo chuẩn Conventional Commits (ví dụ: `feat(adapters): support CyberPanel discovery`, `fix(ssh): handle custom port timeout`).
4. Tạo Pull Request hướng về nhánh `main` kèm mô tả rõ môi trường đã thử nghiệm.

