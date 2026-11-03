import crypto from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';

export const NASSYNC1_CRYPTO_MAGIC = 'NASSYNC1';
export const NASSYNC_CRYPTO_MAGIC = 'NASSYNC2';
export const NASSYNC_CRYPTO_VERSION = 0x01;
export const NASSYNC_KDF_PBKDF2_SHA256 = 0x01;
export const NASSYNC1_HEADER_BYTES = 45; // 8B magic + 1B version + 32B salt + 4B chunkSize
export const NASSYNC_HEADER_BYTES = 49; // 8B magic + 1B kdfId + 4B iterations + 32B salt + 4B chunkSize
export const NASSYNC1_PBKDF2_ITERATIONS = 210_000;
export const NASSYNC_PBKDF2_ITERATIONS = 600_000;
export const NASSYNC_MIN_PBKDF2_ITERATIONS = 10_000;
export const NASSYNC_MAX_PBKDF2_ITERATIONS = 10_000_000;
export const NASSYNC_DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024; // 4 MiB
export const NASSYNC_MIN_CHUNK_SIZE = 1024; // 1 KiB (cho phép chia nhỏ khi unit test)
export const NASSYNC_MAX_CHUNK_SIZE = 64 * 1024 * 1024; // 64 MiB

const NASSYNC1_EOF_AAD = Buffer.from('NASSYNC1-EOF', 'utf8');
const NASSYNC2_EOF_MARKER = Buffer.from('NASSYNC2-EOF', 'utf8');
const FRAME_TYPE_DATA = 0x00;
const FRAME_TYPE_EOF = 0xff;

export interface OffsiteEncryptOptions {
  iterations?: number;
}

function deriveKeyAsync(
  passphrase: string,
  salt: Buffer,
  iterations: number
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(passphrase, salt, iterations, 32, 'sha256', (err, derived) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(derived);
    });
  });
}

function buildNassync2DataAad(
  headerBuf: Buffer,
  frameIndex: number,
  plainLength: number
): Buffer {
  const aad = Buffer.allocUnsafe(headerBuf.length + 1 + 4 + 4);
  headerBuf.copy(aad, 0);
  aad[headerBuf.length] = FRAME_TYPE_DATA;
  aad.writeUInt32BE(frameIndex >>> 0, headerBuf.length + 1);
  aad.writeUInt32BE(plainLength >>> 0, headerBuf.length + 5);
  return aad;
}

function buildNassync2EofAad(headerBuf: Buffer, eofFrameIndex: number): Buffer {
  const aad = Buffer.allocUnsafe(
    headerBuf.length + 1 + 4 + NASSYNC2_EOF_MARKER.length
  );
  headerBuf.copy(aad, 0);
  aad[headerBuf.length] = FRAME_TYPE_EOF;
  aad.writeUInt32BE(eofFrameIndex >>> 0, headerBuf.length + 1);
  NASSYNC2_EOF_MARKER.copy(aad, headerBuf.length + 5);
  return aad;
}

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
 * Luồng mã hóa xác thực theo từng khối `NASSYNC2` (`AES-256-GCM` + `PBKDF2-HMAC-SHA256` 600.000 vòng bất đồng bộ):
 * - Header 49 bytes được gắn làm AAD (Associated Authenticated Data) cho mọi khung dữ liệu & khung kết thúc EOF,
 *   chống giả mạo thông số header (`chunkSize`, `iterations`, `kdfId`, `salt`).
 * - Sinh khóa bất đồng bộ trên libuv threadpool (không chặn Event Loop của Node.js).
 */
export function createOffsiteEncryptStream(
  passphrase: string,
  chunkSize: number = NASSYNC_DEFAULT_CHUNK_SIZE,
  options: OffsiteEncryptOptions = {}
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

  const iterations = options.iterations ?? NASSYNC_PBKDF2_ITERATIONS;
  if (
    !Number.isInteger(iterations) ||
    iterations < NASSYNC_MIN_PBKDF2_ITERATIONS ||
    iterations > NASSYNC_MAX_PBKDF2_ITERATIONS
  ) {
    throw new Error(
      `Số vòng lặp PBKDF2 không hợp lệ (${iterations}). Phải nằm trong khoảng ${NASSYNC_MIN_PBKDF2_ITERATIONS}..${NASSYNC_MAX_PBKDF2_ITERATIONS}.`
    );
  }

  const salt = crypto.randomBytes(32);
  const noncePrefix = crypto.randomBytes(8);
  const headerBuf = Buffer.allocUnsafe(NASSYNC_HEADER_BYTES);
  Buffer.from(NASSYNC_CRYPTO_MAGIC, 'ascii').copy(headerBuf, 0);
  headerBuf[8] = NASSYNC_KDF_PBKDF2_SHA256;
  headerBuf.writeUInt32BE(iterations >>> 0, 9);
  salt.copy(headerBuf, 13);
  headerBuf.writeUInt32BE(chunkSize >>> 0, 45);

  let keyPromise: Promise<Buffer> | null = null;
  const getKey = (): Promise<Buffer> => {
    if (!keyPromise) {
      keyPromise = deriveKeyAsync(passphrase, salt, iterations);
    }
    return keyPromise;
  };

  const queue = new ByteQueue();
  let headerEmitted = false;
  let frameIndex = 0;

  const ensureHeaderPushed = (stream: Transform) => {
    if (headerEmitted) return;
    headerEmitted = true;
    stream.push(Buffer.from(headerBuf));
  };

  const encryptDataFrame = (key: Buffer, plainBuf: Buffer): Buffer => {
    if (frameIndex >= 0x80000000) {
      throw new Error('Vượt quá số lượng khung tối đa của luồng NASSYNC2.');
    }
    const currentIdx = frameIndex;
    const iv = Buffer.allocUnsafe(12);
    noncePrefix.copy(iv, 0);
    iv.writeUInt32BE(currentIdx >>> 0, 8);
    frameIndex++;

    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(buildNassync2DataAad(headerBuf, currentIdx, plainBuf.length));
    const enc1 = cipher.update(plainBuf);
    const enc2 = cipher.final();
    const authTag = cipher.getAuthTag();

    const lenBuf = Buffer.allocUnsafe(4);
    lenBuf.writeUInt32BE(plainBuf.length, 0);

    return Buffer.concat([lenBuf, iv, enc1, enc2, authTag]);
  };

  return new Transform({
    transform(
      chunk: Buffer,
      _encoding: BufferEncoding,
      callback: TransformCallback
    ) {
      void (async () => {
        try {
          const key = await getKey();
          ensureHeaderPushed(this);
          queue.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          while (queue.length >= chunkSize) {
            const plainSlice = queue.consume(chunkSize);
            this.push(encryptDataFrame(key, plainSlice));
          }
          callback();
        } catch (err) {
          callback(err as Error);
        }
      })();
    },
    flush(callback: TransformCallback) {
      void (async () => {
        try {
          const key = await getKey();
          ensureHeaderPushed(this);
          if (queue.length > 0) {
            const rest = queue.consume(queue.length);
            this.push(encryptDataFrame(key, rest));
          }

          const eofIdx = (frameIndex | 0x80000000) >>> 0;
          const eofIv = Buffer.allocUnsafe(12);
          noncePrefix.copy(eofIv, 0);
          eofIv.writeUInt32BE(eofIdx, 8);

          const eofCipher = crypto.createCipheriv('aes-256-gcm', key, eofIv);
          eofCipher.setAAD(buildNassync2EofAad(headerBuf, eofIdx));
          eofCipher.update(Buffer.alloc(0));
          eofCipher.final();
          const eofTag = eofCipher.getAuthTag();

          const eofLenBuf = Buffer.alloc(4); // plainLen = 0
          this.push(Buffer.concat([eofLenBuf, eofIv, eofTag]));
          callback();
        } catch (err) {
          callback(err as Error);
        }
      })();
    },
  });
}

/**
 * Luồng giải mã xác thực hỗ trợ đầy đủ cả `NASSYNC2` (Header AAD + 600k PBKDF2 async)
 * và tương thích ngược 100% với bản sao lưu cũ `NASSYNC1` (210k PBKDF2).
 * Tự động từ chối ngay lập tức nếu sai mật khẩu, bị sửa 1 bit header/dữ liệu, đảo thứ tự khung hoặc cắt cụt EOF!
 */
export function createOffsiteDecryptStream(passphrase: string): Transform {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new Error('Mật khẩu giải mã Offsite (passphrase) không được để trống.');
  }

  const queue = new ByteQueue();
  let headerParsed = false;
  let formatVersion: 1 | 2 = 2;
  let headerRaw: Buffer | null = null;
  let key: Buffer | null = null;
  let maxChunkSize = 0;
  let expectedNoncePrefix: Buffer | null = null;
  let expectedFrameIndex = 0;
  let eofVerified = false;

  return new Transform({
    transform(
      chunk: Buffer,
      _encoding: BufferEncoding,
      callback: TransformCallback
    ) {
      void (async () => {
        try {
          queue.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));

          if (!headerParsed) {
            if (queue.length < 8) {
              callback();
              return;
            }
            const magic = queue.peek(8).toString('ascii');
            if (magic === NASSYNC_CRYPTO_MAGIC) {
              if (queue.length < NASSYNC_HEADER_BYTES) {
                callback();
                return;
              }
              const hdr = Buffer.from(queue.consume(NASSYNC_HEADER_BYTES));
              const kdfId = hdr[8];
              if (kdfId !== NASSYNC_KDF_PBKDF2_SHA256) {
                throw new Error(
                  `Thuật toán KDF trong header NASSYNC2 không được hỗ trợ (kdf=${kdfId}).`
                );
              }
              const iterations = hdr.readUInt32BE(9);
              if (
                iterations < NASSYNC_MIN_PBKDF2_ITERATIONS ||
                iterations > NASSYNC_MAX_PBKDF2_ITERATIONS
              ) {
                throw new Error(
                  `Thông số vòng lặp KDF trong header NASSYNC2 không hợp lệ (${iterations}).`
                );
              }
              const salt = Buffer.from(hdr.subarray(13, 45));
              maxChunkSize = hdr.readUInt32BE(45);
              if (
                maxChunkSize < NASSYNC_MIN_CHUNK_SIZE ||
                maxChunkSize > NASSYNC_MAX_CHUNK_SIZE
              ) {
                throw new Error(
                  `Thông số chunkSize trong header NASSYNC2 không hợp lệ (${maxChunkSize}).`
                );
              }
              key = await deriveKeyAsync(passphrase, salt, iterations);
              formatVersion = 2;
              headerRaw = hdr;
              headerParsed = true;
            } else if (magic === NASSYNC1_CRYPTO_MAGIC) {
              if (queue.length < NASSYNC1_HEADER_BYTES) {
                callback();
                return;
              }
              const hdr = Buffer.from(queue.consume(NASSYNC1_HEADER_BYTES));
              const ver = hdr[8];
              if (ver !== NASSYNC_CRYPTO_VERSION) {
                throw new Error(
                  `Phiên bản định dạng NASSYNC1 không được hỗ trợ (v${ver}).`
                );
              }
              const salt = Buffer.from(hdr.subarray(9, 41));
              maxChunkSize = hdr.readUInt32BE(41);
              if (
                maxChunkSize < NASSYNC_MIN_CHUNK_SIZE ||
                maxChunkSize > NASSYNC_MAX_CHUNK_SIZE
              ) {
                throw new Error(
                  `Thông số chunkSize trong header NASSYNC1 không hợp lệ (${maxChunkSize}).`
                );
              }
              key = await deriveKeyAsync(
                passphrase,
                salt,
                NASSYNC1_PBKDF2_ITERATIONS
              );
              formatVersion = 1;
              headerRaw = hdr;
              headerParsed = true;
            } else {
              throw new Error(
                'Định dạng tệp mã hóa không hợp lệ (không tìm thấy header NASSYNC2/NASSYNC1).'
              );
            }
          }

          while (queue.length >= 16) {
            if (eofVerified) {
              throw new Error(
                'Xác thực Offsite thất bại: phát hiện dữ liệu dư thừa sau khung EOF.'
              );
            }

            const meta = queue.peek(16);
            const plainLen = meta.readUInt32BE(0);
            if (plainLen > maxChunkSize) {
              throw new Error(
                `Xác thực Offsite thất bại: kích thước khung (${plainLen}) vượt quá giới hạn chunkSize (${maxChunkSize}).`
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
                'Xác thực Offsite thất bại: Nonce prefix không đồng nhất trong luồng.'
              );
            }

            if (plainLen === 0) {
              const expectedEofIdx = (expectedFrameIndex | 0x80000000) >>> 0;
              if (idxPart !== expectedEofIdx) {
                throw new Error(
                  'Xác thực khung kết thúc EOF thất bại: chỉ số khung không khớp.'
                );
              }
              const decipher = crypto.createDecipheriv('aes-256-gcm', key!, iv);
              decipher.setAAD(
                formatVersion === 2
                  ? buildNassync2EofAad(headerRaw!, expectedEofIdx)
                  : NASSYNC1_EOF_AAD
              );
              decipher.setAuthTag(authTag);
              decipher.update(Buffer.alloc(0));
              try {
                decipher.final();
              } catch {
                throw new Error(
                  'Giải mã Offsite thất bại: Sai mật khẩu hoặc header/khung EOF đã bị giả mạo!'
                );
              }
              eofVerified = true;
            } else {
              if (idxPart !== expectedFrameIndex >>> 0) {
                throw new Error(
                  'Xác thực Offsite thất bại: thứ tự khung dữ liệu bị thay đổi hoặc mất mát.'
                );
              }
              const currentIdx = expectedFrameIndex;
              expectedFrameIndex++;
              const decipher = crypto.createDecipheriv('aes-256-gcm', key!, iv);
              if (formatVersion === 2) {
                decipher.setAAD(
                  buildNassync2DataAad(headerRaw!, currentIdx, plainLen)
                );
              }
              decipher.setAuthTag(authTag);
              const dec1 = decipher.update(ciphertext);
              let dec2: Buffer;
              try {
                dec2 = decipher.final();
              } catch {
                throw new Error(
                  'Giải mã AES-256-GCM thất bại: Sai mật khẩu hoặc header/dữ liệu sao lưu đã bị chỉnh sửa!'
                );
              }
              this.push(dec2.length > 0 ? Buffer.concat([dec1, dec2]) : dec1);
            }
          }

          if (eofVerified && queue.length > 0) {
            throw new Error(
              'Xác thực Offsite thất bại: phát hiện dữ liệu nối thêm sau khung kết thúc EOF.'
            );
          }

          callback();
        } catch (err) {
          callback(err as Error);
        }
      })();
    },
    flush(callback: TransformCallback) {
      if (!headerParsed) {
        callback(
          new Error(
            'Tệp mã hóa Offsite bị hỏng hoặc cắt cụt (chưa đủ bytes header NASSYNC2/NASSYNC1).'
          )
        );
        return;
      }
      if (!eofVerified || queue.length > 0) {
        callback(
          new Error(
            'Tệp mã hóa Offsite bị cắt cụt giữa chừng (thiếu khung xác thực kết thúc EOF)!'
          )
        );
        return;
      }
      callback();
    },
  });
}
