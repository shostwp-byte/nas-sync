#!/usr/bin/env node
/**
 * NAS-Sync Standalone Emergency Offsite Backup Decryptor (NASSYNC2 & NASSYNC1 / AES-256-GCM)
 * 100% Pure Node.js Built-ins — zero npm dependencies required!
 *
 * Security Note:
 *   Plaintext passphrases on CLI arguments are forbidden to prevent leakage via `ps aux` / `/proc/<pid>/cmdline`.
 *
 * Usage:
 *   NAS_SYNC_PASSPHRASE="..." node scripts/decrypt-offsite-backup.mjs <input.tar.gz.enc> <output.tar.gz>
 *   node scripts/decrypt-offsite-backup.mjs <input.tar.gz.enc> <output.tar.gz> --passphrase-file /path/to/secret.txt
 *   node scripts/decrypt-offsite-backup.mjs <input.tar.gz.enc> <output.tar.gz>   # prompts interactively on TTY
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MAGIC_V1 = 'NASSYNC1';
const MAGIC_V2 = 'NASSYNC2';
const VERSION_V1 = 0x01;
const KDF_PBKDF2_SHA256 = 0x01;
const HEADER_BYTES_V1 = 45;
const HEADER_BYTES_V2 = 49;
const PBKDF2_ITERATIONS_V1 = 210_000;
const MIN_PBKDF2_ITERATIONS = 10_000;
const MAX_PBKDF2_ITERATIONS = 10_000_000;
const MIN_CHUNK_SIZE = 1024;
const MAX_CHUNK_SIZE = 64 * 1024 * 1024;
const EOF_AAD_V1 = Buffer.from('NASSYNC1-EOF', 'utf8');
const EOF_MARKER_V2 = Buffer.from('NASSYNC2-EOF', 'utf8');

function deriveKeyAsync(passphrase, salt, iterations) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(passphrase, salt, iterations, 32, 'sha256', (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

function buildV2DataAad(headerBuf, frameIdx, plainLen) {
  const aad = Buffer.allocUnsafe(headerBuf.length + 1 + 4 + 4);
  headerBuf.copy(aad, 0);
  aad[headerBuf.length] = 0x00;
  aad.writeUInt32BE(frameIdx >>> 0, headerBuf.length + 1);
  aad.writeUInt32BE(plainLen >>> 0, headerBuf.length + 5);
  return aad;
}

function buildV2EofAad(headerBuf, eofIdx) {
  const aad = Buffer.allocUnsafe(headerBuf.length + 1 + 4 + EOF_MARKER_V2.length);
  headerBuf.copy(aad, 0);
  aad[headerBuf.length] = 0xff;
  aad.writeUInt32BE(eofIdx >>> 0, headerBuf.length + 1);
  EOF_MARKER_V2.copy(aad, headerBuf.length + 5);
  return aad;
}

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
  let formatVersion = 2;
  let headerRaw = null;
  let key = null;
  let maxChunkSize = 0;
  let expectedNoncePrefix = null;
  let expectedFrameIndex = 0;
  let eofVerified = false;

  return new Transform({
    transform(chunk, _encoding, callback) {
      void (async () => {
        try {
          queue.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));

          if (!headerParsed) {
            if (queue.length < 8) {
              callback();
              return;
            }
            const magic = queue.peek(8).toString('ascii');
            if (magic === MAGIC_V2) {
              if (queue.length < HEADER_BYTES_V2) {
                callback();
                return;
              }
              const hdr = Buffer.from(queue.consume(HEADER_BYTES_V2));
              if (hdr[8] !== KDF_PBKDF2_SHA256) {
                throw new Error(`Unsupported NASSYNC2 KDF ID: ${hdr[8]}`);
              }
              const iterations = hdr.readUInt32BE(9);
              if (
                iterations < MIN_PBKDF2_ITERATIONS ||
                iterations > MAX_PBKDF2_ITERATIONS
              ) {
                throw new Error(`Invalid PBKDF2 iterations in header: ${iterations}`);
              }
              const salt = Buffer.from(hdr.subarray(13, 45));
              maxChunkSize = hdr.readUInt32BE(45);
              if (maxChunkSize < MIN_CHUNK_SIZE || maxChunkSize > MAX_CHUNK_SIZE) {
                throw new Error(`Invalid chunkSize in header: ${maxChunkSize}`);
              }
              key = await deriveKeyAsync(passphrase, salt, iterations);
              formatVersion = 2;
              headerRaw = hdr;
              headerParsed = true;
            } else if (magic === MAGIC_V1) {
              if (queue.length < HEADER_BYTES_V1) {
                callback();
                return;
              }
              const hdr = Buffer.from(queue.consume(HEADER_BYTES_V1));
              if (hdr[8] !== VERSION_V1) {
                throw new Error(`Unsupported NASSYNC1 version: ${hdr[8]}`);
              }
              const salt = Buffer.from(hdr.subarray(9, 41));
              maxChunkSize = hdr.readUInt32BE(41);
              if (maxChunkSize < MIN_CHUNK_SIZE || maxChunkSize > MAX_CHUNK_SIZE) {
                throw new Error(`Invalid chunkSize in header: ${maxChunkSize}`);
              }
              key = await deriveKeyAsync(passphrase, salt, PBKDF2_ITERATIONS_V1);
              formatVersion = 1;
              headerRaw = hdr;
              headerParsed = true;
            } else {
              throw new Error(
                'Invalid file header: missing NASSYNC2 / NASSYNC1 magic.'
              );
            }
          }

          while (queue.length >= 16) {
            if (eofVerified) {
              throw new Error('Unexpected trailing bytes after EOF frame.');
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
              decipher.setAAD(
                formatVersion === 2
                  ? buildV2EofAad(headerRaw, expectedEofIdx)
                  : EOF_AAD_V1
              );
              decipher.setAuthTag(authTag);
              decipher.update(Buffer.alloc(0));
              decipher.final();
              eofVerified = true;
            } else {
              if (idxPart !== expectedFrameIndex >>> 0) {
                throw new Error('Out-of-order or missing stream frame.');
              }
              const currentIdx = expectedFrameIndex;
              expectedFrameIndex++;
              const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
              if (formatVersion === 2) {
                decipher.setAAD(buildV2DataAad(headerRaw, currentIdx, plainLen));
              }
              decipher.setAuthTag(authTag);
              const dec1 = decipher.update(ciphertext);
              const dec2 = decipher.final();
              this.push(dec2.length > 0 ? Buffer.concat([dec1, dec2]) : dec1);
            }
          }

          if (eofVerified && queue.length > 0) {
            throw new Error('Unexpected trailing bytes after EOF frame.');
          }

          callback();
        } catch (err) {
          callback(err);
        }
      })();
    },
    flush(callback) {
      if (!headerParsed || !eofVerified || queue.length > 0) {
        callback(
          new Error(
            'Truncated or corrupted archive (missing authenticated EOF frame).'
          )
        );
        return;
      }
      callback();
    },
  });
}

function promptHiddenPassphrase(promptText) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(
        new Error(
          'No passphrase provided via --passphrase-file or NAS_SYNC_PASSPHRASE, and stdin is not a TTY.'
        )
      );
      return;
    }
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: true,
    });
    const origWrite = rl._writeToOutput;
    rl._writeToOutput = function writeMasked(str) {
      if (str.includes(promptText)) {
        origWrite.call(rl, promptText);
      }
    };
    rl.question(promptText, (answer) => {
      rl.close();
      process.stderr.write('\n');
      resolve(answer.trim());
    });
  });
}

async function resolvePassphrase(extraArgs) {
  for (let i = 0; i < extraArgs.length; i++) {
    const arg = extraArgs[i];
    if (arg === '--passphrase-file') {
      const filePath = extraArgs[i + 1];
      if (!filePath) {
        throw new Error('Missing path after --passphrase-file');
      }
      return fs.readFileSync(path.resolve(filePath), 'utf8').replace(/\r?\n$/, '');
    }
    if (arg.startsWith('--passphrase-file=')) {
      const filePath = arg.slice('--passphrase-file='.length);
      return fs.readFileSync(path.resolve(filePath), 'utf8').replace(/\r?\n$/, '');
    }
    throw new Error(
      '[SECURITY] Passing plaintext passphrase directly on CLI arguments is disabled (visible in ps aux). Use NAS_SYNC_PASSPHRASE env var, --passphrase-file <file>, or interactive TTY prompt.'
    );
  }

  if (process.env.NAS_SYNC_PASSPHRASE) {
    return process.env.NAS_SYNC_PASSPHRASE;
  }

  return await promptHiddenPassphrase('Enter NAS-Sync Offsite Passphrase: ');
}

async function main() {
  const args = process.argv.slice(2);
  const positionals = [];
  const optionArgs = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--passphrase-file') {
      optionArgs.push(a);
      if (i + 1 < args.length) {
        optionArgs.push(args[i + 1]);
        i++;
      }
    } else if (a.startsWith('-')) {
      optionArgs.push(a);
    } else {
      positionals.push(a);
    }
  }

  const inputPath = positionals[0];
  const outputPath = positionals[1];
  const extraPositionals = positionals.slice(2);

  if (!inputPath || !outputPath) {
    console.error(
      'Usage:\n' +
        '  NAS_SYNC_PASSPHRASE="..." node scripts/decrypt-offsite-backup.mjs <input.tar.gz.enc> <output.tar.gz>\n' +
        '  node scripts/decrypt-offsite-backup.mjs <input.tar.gz.enc> <output.tar.gz> --passphrase-file <secret.txt>'
    );
    process.exit(1);
  }

  let passphrase = '';
  try {
    passphrase = await resolvePassphrase([...optionArgs, ...extraPositionals]);
  } catch (err) {
    console.error(`[NAS-Sync Decrypt] ${err.message}`);
    process.exit(1);
  }

  if (!passphrase) {
    console.error('[NAS-Sync Decrypt] Error: Passphrase must not be empty.');
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
