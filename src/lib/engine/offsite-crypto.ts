import crypto from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';

export const NASSYNC_CRYPTO_MAGIC = 'NASSYNC1';
export const NASSYNC_CRYPTO_VERSION = 0x01;
export const NASSYNC_HEADER_BYTES = 45; // 8B magic + 1B version + 32B salt + 4B chunkSize
export const NASSYNC_PBKDF2_ITERATIONS = 210_000;
export const NASSYNC_DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024; // 4 MiB
export const NASSYNC_MIN_CHUNK_SIZE = 1024; // 1 KiB (cho phép chia nhỏ khi unit test)
export const NASSYNC_MAX_CHUNK_SIZE = 64 * 1024 * 1024; // 64 MiB
const EOF_AAD = Buffer.from('NASSYNC1-EOF', 'utf8');

class ByteQueue {
  private chunks: Buffer[] = [];
  private headOffset = 0;
  public length = 0;

  push(buf: Buffer): void {
    if (buf.length === 0) return;
    this.chunks.push(buf);
    this.length += buf.length;
  }

  peek(n: number): Buffer {
    if (n <= 0) return Buffer.alloc(0);
    if (this.length < n) {
      throw new Error('ByteQueue underflow on peek');
    }
    const first = this.chunks[0];
    const availInFirst = first.length - this.headOffset;
    if (availInFirst >= n) {
      return first.subarray(this.headOffset, this.headOffset + n);
    }
    const out = Buffer.allocUnsafe(n);
    let copied = 0;
    for (let i = 0; i < this.chunks.length && copied < n; i++) {
      const c = this.chunks[i];
      const start = i === 0 ? this.headOffset : 0;
      const take = Math.min(c.length - start, n - copied);
      c.copy(out, copied, start, start + take);
      copied += take;
    }
    return out;
  }

  consume(n: number): Buffer {
    if (n <= 0) return Buffer.alloc(0);
    if (this.length < n) {
      throw new Error('ByteQueue underflow on consume');
    }
    const first = this.chunks[0];
    const availInFirst = first.length - this.headOffset;
    if (availInFirst === n) {
      const slice =
        this.headOffset === 0 ? first : first.subarray(this.headOffset);
      this.chunks.shift();
      this.headOffset = 0;
      this.length -= n;
      return slice;
    }
    if (availInFirst > n) {
      const slice = first.subarray(this.headOffset, this.headOffset + n);
      this.headOffset += n;
      this.length -= n;
      return slice;
    }

    const out = Buffer.allocUnsafe(n);
    let copied = 0;
    while (copied < n) {
      const c = this.chunks[0];
      const start = this.headOffset;
      const avail = c.length - start;
      const take = Math.min(avail, n - copied);
      c.copy(out, copied, start, start + take);
      copied += take;
      if (take === avail) {
        this.chunks.shift();
        this.headOffset = 0;
      } else {
        this.headOffset += take;
      }
    }
    this.length -= n;
    return out;
  }
}

/**
 * Luồng mã hóa xác thực theo từng khối `NASSYNC1` (`AES-256-GCM` + `PBKDF2-HMAC-SHA256` 210.000 vòng)
 * Không tốn ổ cứng tạm trên NAS (Zero-Temp-Disk Stream Encryption).
 */
export function createOffsiteEncryptStream(
  passphrase: string,
  chunkSize: number = NASSYNC_DEFAULT_CHUNK_SIZE
): Transform {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new Error('Mật khẩu mã hóa Offsite (passphrase) không được để trống.');
  }
  if (
    !Number.isInteger(chunkSize) ||
    chunkSize < NASSYNC_MIN_CHUNK_SIZE ||
    chunkSize > NASSYNC_MAX_CHUNK_SIZE
  ) {
    throw new Error(
      `Kích thước chunkSize không hợp lệ (${chunkSize}). Phải nằm trong khoảng ${NASSYNC_MIN_CHUNK_SIZE}..${NASSYNC_MAX_CHUNK_SIZE} bytes.`
    );
  }

  const salt = crypto.randomBytes(32);
  const noncePrefix = crypto.randomBytes(8);
  const key = crypto.pbkdf2Sync(
    passphrase,
    salt,
    NASSYNC_PBKDF2_ITERATIONS,
    32,
    'sha256'
  );

  const queue = new ByteQueue();
  let headerEmitted = false;
  let frameIndex = 0;

  const ensureHeaderPushed = (stream: Transform) => {
    if (headerEmitted) return;
    headerEmitted = true;
    const header = Buffer.allocUnsafe(NASSYNC_HEADER_BYTES);
    Buffer.from(NASSYNC_CRYPTO_MAGIC, 'ascii').copy(header, 0);
    header[8] = NASSYNC_CRYPTO_VERSION;
    salt.copy(header, 9);
    header.writeUInt32BE(chunkSize, 41);
    stream.push(header);
  };

  const encryptDataFrame = (plainBuf: Buffer): Buffer => {
    if (frameIndex >= 0x80000000) {
      throw new Error('Vượt quá số lượng khung tối đa của luồng NASSYNC1.');
    }
    const iv = Buffer.allocUnsafe(12);
    noncePrefix.copy(iv, 0);
    iv.writeUInt32BE(frameIndex >>> 0, 8);
    frameIndex++;

    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc1 = cipher.update(plainBuf);
    const enc2 = cipher.final();
    const authTag = cipher.getAuthTag();

    const lenBuf = Buffer.allocUnsafe(4);
    lenBuf.writeUInt32BE(plainBuf.length, 0);

    return Buffer.concat([lenBuf, iv, enc1, enc2, authTag]);
  };

  return new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      try {
        ensureHeaderPushed(this);
        queue.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        while (queue.length >= chunkSize) {
          const plainSlice = queue.consume(chunkSize);
          this.push(encryptDataFrame(plainSlice));
        }
        callback();
      } catch (err) {
        callback(err as Error);
      }
    },
    flush(callback: TransformCallback) {
      try {
        ensureHeaderPushed(this);
        if (queue.length > 0) {
          const rest = queue.consume(queue.length);
          this.push(encryptDataFrame(rest));
        }

        // Khung kết thúc xác thực EOF chống tấn công cắt cụt luồng (Truncation Attack)
        const eofIv = Buffer.allocUnsafe(12);
        noncePrefix.copy(eofIv, 0);
        eofIv.writeUInt32BE((frameIndex | 0x80000000) >>> 0, 8);

        const eofCipher = crypto.createCipheriv('aes-256-gcm', key, eofIv);
        eofCipher.setAAD(EOF_AAD);
        eofCipher.update(Buffer.alloc(0));
        eofCipher.final();
        const eofTag = eofCipher.getAuthTag();

        const eofLenBuf = Buffer.alloc(4); // plainLen = 0
        this.push(Buffer.concat([eofLenBuf, eofIv, eofTag]));
        callback();
      } catch (err) {
        callback(err as Error);
      }
    },
  });
}

/**
 * Luồng giải mã xác thực `NASSYNC1` (`AES-256-GCM`)
 * Tự động từ chối ngay lập tức nếu sai mật khẩu, bị sửa 1 bit dữ liệu, đảo thứ tự khung hoặc cắt cụt EOF!
 */
export function createOffsiteDecryptStream(passphrase: string): Transform {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new Error('Mật khẩu giải mã Offsite (passphrase) không được để trống.');
  }

  const queue = new ByteQueue();
  let headerParsed = false;
  let key: Buffer | null = null;
  let maxChunkSize = 0;
  let expectedNoncePrefix: Buffer | null = null;
  let expectedFrameIndex = 0;
  let eofVerified = false;

  return new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      try {
        queue.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));

        if (!headerParsed) {
          if (queue.length < NASSYNC_HEADER_BYTES) {
            callback();
            return;
          }
          const hdr = queue.consume(NASSYNC_HEADER_BYTES);
          const magic = hdr.subarray(0, 8).toString('ascii');
          if (magic !== NASSYNC_CRYPTO_MAGIC) {
            throw new Error(
              'Định dạng tệp mã hóa không hợp lệ (không tìm thấy header NASSYNC1).'
            );
          }
          const ver = hdr[8];
          if (ver !== NASSYNC_CRYPTO_VERSION) {
            throw new Error(
              `Phiên bản định dạng NASSYNC1 không được hỗ trợ (v${ver}).`
            );
          }
          const salt = hdr.subarray(9, 41);
          maxChunkSize = hdr.readUInt32BE(41);
          if (
            maxChunkSize < NASSYNC_MIN_CHUNK_SIZE ||
            maxChunkSize > NASSYNC_MAX_CHUNK_SIZE
          ) {
            throw new Error(
              `Thông số chunkSize trong header NASSYNC1 không hợp lệ (${maxChunkSize}).`
            );
          }
          key = crypto.pbkdf2Sync(
            passphrase,
            salt,
            NASSYNC_PBKDF2_ITERATIONS,
            32,
            'sha256'
          );
          headerParsed = true;
        }

        while (queue.length >= 16) {
          if (eofVerified) {
            throw new Error(
              'Xác thực NASSYNC1 thất bại: phát hiện dữ liệu dư thừa sau khung EOF.'
            );
          }

          const meta = queue.peek(16);
          const plainLen = meta.readUInt32BE(0);
          if (plainLen > maxChunkSize) {
            throw new Error(
              `Xác thực NASSYNC1 thất bại: kích thước khung (${plainLen}) vượt quá giới hạn chunkSize (${maxChunkSize}).`
            );
          }

          const totalFrameBytes = 4 + 12 + plainLen + 16;
          if (queue.length < totalFrameBytes) {
            break;
          }

          const frame = queue.consume(totalFrameBytes);
          const iv = frame.subarray(4, 16);
          const ciphertext = frame.subarray(16, 16 + plainLen);
          const authTag = frame.subarray(16 + plainLen, 32 + plainLen);

          const noncePart = iv.subarray(0, 8);
          const idxPart = iv.readUInt32BE(8);

          if (!expectedNoncePrefix) {
            expectedNoncePrefix = Buffer.from(noncePart);
          } else if (!crypto.timingSafeEqual(noncePart, expectedNoncePrefix)) {
            throw new Error(
              'Xác thực NASSYNC1 thất bại: Nonce prefix không đồng nhất trong luồng.'
            );
          }

          if (plainLen === 0) {
            const expectedEofIdx = (expectedFrameIndex | 0x80000000) >>> 0;
            if (idxPart !== expectedEofIdx) {
              throw new Error(
                'Xác thực khung kết thúc NASSYNC1-EOF thất bại: chỉ số khung không khớp.'
              );
            }
            const decipher = crypto.createDecipheriv('aes-256-gcm', key!, iv);
            decipher.setAAD(EOF_AAD);
            decipher.setAuthTag(authTag);
            decipher.update(Buffer.alloc(0));
            try {
              decipher.final();
            } catch {
              throw new Error(
                'Giải mã NASSYNC1 thất bại: Sai mật khẩu hoặc khung EOF đã bị giả mạo!'
              );
            }
            eofVerified = true;
          } else {
            if (idxPart !== expectedFrameIndex >>> 0) {
              throw new Error(
                'Xác thực NASSYNC1 thất bại: thứ tự khung dữ liệu bị thay đổi hoặc mất mát.'
              );
            }
            expectedFrameIndex++;
            const decipher = crypto.createDecipheriv('aes-256-gcm', key!, iv);
            decipher.setAuthTag(authTag);
            const dec1 = decipher.update(ciphertext);
            let dec2: Buffer;
            try {
              dec2 = decipher.final();
            } catch {
              throw new Error(
                'Giải mã AES-256-GCM thất bại: Sai mật khẩu hoặc dữ liệu sao lưu đã bị chỉnh sửa!'
              );
            }
            this.push(dec2.length > 0 ? Buffer.concat([dec1, dec2]) : dec1);
          }
        }

        if (eofVerified && queue.length > 0) {
          throw new Error(
            'Xác thực NASSYNC1 thất bại: phát hiện dữ liệu nối thêm sau khung kết thúc EOF.'
          );
        }

        callback();
      } catch (err) {
        callback(err as Error);
      }
    },
    flush(callback: TransformCallback) {
      if (!headerParsed) {
        callback(
          new Error(
            'Tệp mã hóa NASSYNC1 bị hỏng hoặc cắt cụt (chưa đủ 45 bytes header).'
          )
        );
        return;
      }
      if (!eofVerified || queue.length > 0) {
        callback(
          new Error(
            'Tệp mã hóa NASSYNC1 bị cắt cụt giữa chừng (thiếu khung xác thực kết thúc NASSYNC1-EOF)!'
          )
        );
        return;
      }
      callback();
    },
  });
}
