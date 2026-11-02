#!/usr/bin/env node
/**
 * NAS-Sync Standalone Emergency Offsite Backup Decryptor (NASSYNC1 / AES-256-GCM)
 * 100% Pure Node.js Built-ins — zero npm dependencies required!
 *
 * Usage:
 *   node scripts/decrypt-offsite-backup.mjs <input.tar.gz.enc> <output.tar.gz> <passphrase>
 *   (or set NAS_SYNC_PASSPHRASE="<passphrase>" if omitting the 3rd CLI argument)
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MAGIC = 'NASSYNC1';
const VERSION = 0x01;
const HEADER_BYTES = 45;
const PBKDF2_ITERATIONS = 210_000;
const MIN_CHUNK_SIZE = 1024;
const MAX_CHUNK_SIZE = 64 * 1024 * 1024;
const EOF_AAD = Buffer.from('NASSYNC1-EOF', 'utf8');

class ByteQueue {
  constructor() {
    this.chunks = [];
    this.headOffset = 0;
    this.length = 0;
  }

  push(buf) {
    if (buf.length === 0) return;
    this.chunks.push(buf);
    this.length += buf.length;
  }

  peek(n) {
    if (n <= 0) return Buffer.alloc(0);
    const first = this.chunks[0];
    if (first.length - this.headOffset >= n) {
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

  consume(n) {
    if (n <= 0) return Buffer.alloc(0);
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

function createDecryptStream(passphrase) {
  const queue = new ByteQueue();
  let headerParsed = false;
  let key = null;
  let maxChunkSize = 0;
  let expectedNoncePrefix = null;
  let expectedFrameIndex = 0;
  let eofVerified = false;

  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        queue.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));

        if (!headerParsed) {
          if (queue.length < HEADER_BYTES) {
            callback();
            return;
          }
          const hdr = queue.consume(HEADER_BYTES);
          if (hdr.subarray(0, 8).toString('ascii') !== MAGIC) {
            throw new Error('Invalid file header: missing NASSYNC1 magic.');
          }
          if (hdr[8] !== VERSION) {
            throw new Error(`Unsupported NASSYNC1 version: ${hdr[8]}`);
          }
          const salt = hdr.subarray(9, 41);
          maxChunkSize = hdr.readUInt32BE(41);
          if (maxChunkSize < MIN_CHUNK_SIZE || maxChunkSize > MAX_CHUNK_SIZE) {
            throw new Error(`Invalid chunkSize in header: ${maxChunkSize}`);
          }
          key = crypto.pbkdf2Sync(
            passphrase,
            salt,
            PBKDF2_ITERATIONS,
            32,
            'sha256'
          );
          headerParsed = true;
        }

        while (queue.length >= 16) {
          if (eofVerified) {
            throw new Error('Unexpected trailing bytes after NASSYNC1-EOF.');
          }
          const meta = queue.peek(16);
          const plainLen = meta.readUInt32BE(0);
          if (plainLen > maxChunkSize) {
            throw new Error(`Frame length ${plainLen} exceeds ${maxChunkSize}`);
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
            throw new Error('Nonce prefix mismatch across stream frames.');
          }

          if (plainLen === 0) {
            const expectedEofIdx = (expectedFrameIndex | 0x80000000) >>> 0;
            if (idxPart !== expectedEofIdx) {
              throw new Error('EOF frame index mismatch.');
            }
            const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
            decipher.setAAD(EOF_AAD);
            decipher.setAuthTag(authTag);
            decipher.update(Buffer.alloc(0));
            decipher.final();
            eofVerified = true;
          } else {
            if (idxPart !== expectedFrameIndex >>> 0) {
              throw new Error('Out-of-order or missing stream frame.');
            }
            expectedFrameIndex++;
            const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
            decipher.setAuthTag(authTag);
            const dec1 = decipher.update(ciphertext);
            const dec2 = decipher.final();
            this.push(dec2.length > 0 ? Buffer.concat([dec1, dec2]) : dec1);
          }
        }

        if (eofVerified && queue.length > 0) {
          throw new Error('Unexpected trailing bytes after NASSYNC1-EOF.');
        }

        callback();
      } catch (err) {
        callback(err);
      }
    },
    flush(callback) {
      if (!headerParsed || !eofVerified || queue.length > 0) {
        callback(
          new Error(
            'Truncated or corrupted NASSYNC1 archive (missing authenticated EOF frame).'
          )
        );
        return;
      }
      callback();
    },
  });
}

async function main() {
  const [inputPath, outputPath, cliPassphrase] = process.argv.slice(2);
  const passphrase = cliPassphrase || process.env.NAS_SYNC_PASSPHRASE || '';

  if (!inputPath || !outputPath || !passphrase) {
    console.error(
      'Usage: node scripts/decrypt-offsite-backup.mjs <input.tar.gz.enc> <output.tar.gz> <passphrase>'
    );
    process.exit(1);
  }

  const resolvedIn = path.resolve(inputPath);
  const resolvedOut = path.resolve(outputPath);
  const tempOut = `${resolvedOut}.decrypting-${process.pid}`;

  if (!fs.existsSync(resolvedIn)) {
    console.error(`Error: Input file not found: ${resolvedIn}`);
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
  const startedAt = Date.now();
  console.log(`[NAS-Sync Decrypt] Decrypting ${resolvedIn} -> ${resolvedOut} ...`);

  try {
    await pipeline(
      fs.createReadStream(resolvedIn),
      createDecryptStream(passphrase),
      fs.createWriteStream(tempOut, { mode: 0o600 })
    );
    fs.renameSync(tempOut, resolvedOut);
    const outSize = fs.statSync(resolvedOut).size;
    const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(2);
    console.log(
      `[NAS-Sync Decrypt] Verified & decrypted successfully (${(
        outSize /
        1024 ** 2
      ).toFixed(2)} MiB in ${elapsedSec}s).`
    );
    console.log(`[NAS-Sync Decrypt] Extract archive with: tar -xzf "${resolvedOut}"`);
  } catch (err) {
    fs.rmSync(tempOut, { force: true });
    console.error(`[NAS-Sync Decrypt] FAILED: ${err.message}`);
    process.exit(1);
  }
}

main();
