/**
 * Zero-dependency ISO/IEC 18004 QR Code Matrix & SVG Encoder (UTF-8 Byte Mode, Versions 1–40).
 * Eliminates external native/npm dependencies during TOTP 2FA setup so 1-Click Self-Update
 * stays completely dependency-stable on multi-NAS Docker containers.
 */

export type QrErrorCorrectionLevel = 'L' | 'M' | 'Q' | 'H';

export interface QrSvgOptions {
  errorCorrectionLevel?: QrErrorCorrectionLevel;
  margin?: number;
  width?: number;
  color?: {
    dark?: string;
    light?: string;
  };
}

export interface QrMatrix {
  version: number;
  size: number;
  mask: number;
  modules: Uint8Array;
}

const EC_LEVEL_INDEX: Record<QrErrorCorrectionLevel, number> = {
  L: 0,
  M: 1,
  Q: 2,
  H: 3,
};

const EC_FORMAT_BITS: Record<QrErrorCorrectionLevel, number> = {
  L: 0b01,
  M: 0b00,
  Q: 0b11,
  H: 0b10,
};

// ISO/IEC 18004 Table 9: Number of Error Correction Blocks per Version (1..40) for [L, M, Q, H]
const EC_BLOCKS_TABLE: readonly number[] = [
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 1, 2, 2, 4, 1, 2, 4, 4, 2, 4, 4, 4, 2, 4,
  6, 5, 2, 4, 6, 6, 2, 5, 8, 8, 4, 5, 8, 8, 4, 5, 8, 11, 4, 8, 10, 11, 4, 9, 12,
  16, 4, 9, 16, 16, 6, 10, 12, 18, 6, 10, 17, 16, 6, 11, 16, 19, 6, 13, 18, 21,
  7, 14, 21, 25, 8, 16, 20, 25, 8, 17, 23, 25, 9, 17, 23, 34, 9, 18, 25, 30, 10,
  20, 27, 32, 12, 21, 29, 35, 12, 23, 34, 37, 12, 25, 34, 40, 13, 26, 35, 42,
  14, 28, 38, 45, 15, 29, 40, 48, 16, 31, 43, 51, 17, 33, 45, 54, 18, 35, 48,
  57, 19, 37, 51, 60, 19, 38, 53, 63, 20, 40, 56, 66, 21, 43, 59, 70, 22, 45,
  62, 74, 24, 47, 65, 77, 25, 49, 68, 81,
];

// ISO/IEC 18004 Table 9: Total Error Correction Codewords per Version (1..40) for [L, M, Q, H]
const EC_CODEWORDS_TABLE: readonly number[] = [
  7, 10, 13, 17, 10, 16, 22, 28, 15, 26, 36, 44, 20, 36, 52, 64, 26, 48, 72, 88,
  36, 64, 96, 112, 40, 72, 108, 130, 48, 88, 132, 156, 60, 110, 160, 192, 72,
  130, 192, 224, 80, 150, 224, 264, 96, 176, 260, 308, 104, 198, 288, 352, 120,
  216, 320, 384, 132, 240, 360, 432, 144, 280, 408, 480, 168, 308, 448, 532,
  180, 338, 504, 588, 196, 364, 546, 650, 224, 416, 600, 700, 224, 442, 644,
  750, 252, 476, 690, 816, 270, 504, 750, 900, 300, 560, 810, 960, 312, 588,
  870, 1050, 336, 644, 952, 1110, 360, 700, 1020, 1200, 390, 728, 1050, 1260,
  420, 784, 1140, 1350, 450, 812, 1200, 1440, 480, 868, 1290, 1530, 510, 924,
  1350, 1620, 540, 980, 1440, 1710, 570, 1036, 1530, 1800, 570, 1064, 1590,
  1890, 600, 1120, 1680, 1980, 630, 1204, 1770, 2100, 660, 1260, 1860, 2220,
  720, 1316, 1950, 2310, 750, 1372, 2040, 2430,
];

// GF(256) lookup tables with primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11d)
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

(function initGaloisTables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) {
      x ^= 0x11d;
    }
  }
  for (let i = 255; i < 512; i++) {
    GF_EXP[i] = GF_EXP[i - 255];
  }
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function buildRsDivisor(degree: number): Uint8Array {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) {
        result[j] ^= result[j + 1];
      }
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function computeRsRemainder(data: Uint8Array, divisor: Uint8Array): Uint8Array {
  const rem = new Uint8Array(divisor.length);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ rem[0];
    rem.copyWithin(0, 1);
    rem[divisor.length - 1] = 0;
    if (factor !== 0) {
      for (let j = 0; j < divisor.length; j++) {
        rem[j] ^= gfMul(divisor[j], factor);
      }
    }
  }
  return rem;
}

function getNumRawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) {
      result -= 36;
    }
  }
  return result;
}

function getAlignmentCoords(version: number): number[] {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const step =
    version === 32
      ? 26
      : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const coords = [6];
  for (let pos = version * 4 + 10; coords.length < numAlign; pos -= step) {
    coords.splice(1, 0, pos);
  }
  return coords;
}

function getEncodedFormatBits(
  ecLevel: QrErrorCorrectionLevel,
  mask: number
): number {
  const data = (EC_FORMAT_BITS[ecLevel] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) {
    rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  }
  return ((data << 10) | rem) ^ 0x5412;
}

function getEncodedVersionBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i++) {
    rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  }
  return (version << 12) | rem;
}

function shouldInvertForMask(mask: number, row: number, col: number): boolean {
  switch (mask) {
    case 0:
      return (row + col) % 2 === 0;
    case 1:
      return row % 2 === 0;
    case 2:
      return col % 3 === 0;
    case 3:
      return (row + col) % 3 === 0;
    case 4:
      return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5:
      return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6:
      return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    case 7:
      return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
    default:
      return false;
  }
}

function computeMaskPenalty(modules: Uint8Array, size: number): number {
  let penalty = 0;

  // N1: 5+ consecutive modules of same color in row / column
  for (let r = 0; r < size; r++) {
    let runColor = modules[r * size];
    let runLen = 1;
    for (let c = 1; c < size; c++) {
      const color = modules[r * size + c];
      if (color === runColor) {
        runLen++;
        if (runLen === 5) penalty += 3;
        else if (runLen > 5) penalty += 1;
      } else {
        runColor = color;
        runLen = 1;
      }
    }
  }

  for (let c = 0; c < size; c++) {
    let runColor = modules[c];
    let runLen = 1;
    for (let r = 1; r < size; r++) {
      const color = modules[r * size + c];
      if (color === runColor) {
        runLen++;
        if (runLen === 5) penalty += 3;
        else if (runLen > 5) penalty += 1;
      } else {
        runColor = color;
        runLen = 1;
      }
    }
  }

  // N2: 2x2 blocks of same color
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const color = modules[r * size + c];
      if (
        color === modules[r * size + c + 1] &&
        color === modules[(r + 1) * size + c] &&
        color === modules[(r + 1) * size + c + 1]
      ) {
        penalty += 3;
      }
    }
  }

  // N3: 11-module finder-like patterns 10111010000 (0x5d0) or 00001011101 (0x05d)
  for (let r = 0; r < size; r++) {
    let bitsRow = 0;
    let bitsCol = 0;
    for (let c = 0; c < size; c++) {
      bitsRow = ((bitsRow << 1) & 0x7ff) | modules[r * size + c];
      if (c >= 10 && (bitsRow === 0x5d0 || bitsRow === 0x05d)) {
        penalty += 40;
      }
      bitsCol = ((bitsCol << 1) & 0x7ff) | modules[c * size + r];
      if (c >= 10 && (bitsCol === 0x5d0 || bitsCol === 0x05d)) {
        penalty += 40;
      }
    }
  }

  // N4: Balance of dark modules relative to 50% in 5% steps
  let darkCount = 0;
  const total = size * size;
  for (let i = 0; i < total; i++) {
    darkCount += modules[i];
  }
  const k = Math.abs(Math.ceil((darkCount * 100) / total / 5) - 10);
  penalty += k * 10;

  return penalty;
}

function drawFormatInfo(
  modules: Uint8Array,
  reserved: Uint8Array,
  size: number,
  ecLevel: QrErrorCorrectionLevel,
  mask: number
) {
  const bits = getEncodedFormatBits(ecLevel, mask);
  for (let i = 0; i < 15; i++) {
    const bit = (bits >>> i) & 1;

    // Vertical copy
    const vr = i < 6 ? i : i < 8 ? i + 1 : size - 15 + i;
    modules[vr * size + 8] = bit;
    reserved[vr * size + 8] = 1;

    // Horizontal copy
    const hc = i < 8 ? size - i - 1 : i < 9 ? 15 - i : 14 - i;
    modules[8 * size + hc] = bit;
    reserved[8 * size + hc] = 1;
  }

  // Fixed dark module
  modules[(size - 8) * size + 8] = 1;
  reserved[(size - 8) * size + 8] = 1;
}

export function encodeQrMatrix(
  text: string,
  ecLevel: QrErrorCorrectionLevel = 'M'
): QrMatrix {
  const payload = Buffer.from(text, 'utf8');
  const ecIdx = EC_LEVEL_INDEX[ecLevel];

  let version = 0;
  let totalCodewords = 0;
  let dataCapacityCodewords = 0;

  for (let v = 1; v <= 40; v++) {
    const rawCodewords = Math.floor(getNumRawDataModules(v) / 8);
    const ecCodewords = EC_CODEWORDS_TABLE[(v - 1) * 4 + ecIdx];
    const dataCw = rawCodewords - ecCodewords;
    const countBits = v <= 9 ? 8 : 16;
    if (4 + countBits + payload.length * 8 <= dataCw * 8) {
      version = v;
      totalCodewords = rawCodewords;
      dataCapacityCodewords = dataCw;
      break;
    }
  }

  if (version === 0) {
    throw new Error('Chuỗi dữ liệu quá dài để mã hóa thành mã QR (vượt quá Version 40).');
  }

  // Pack bit stream in Byte mode (0100)
  const bits: number[] = [];
  const pushBits = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) {
      bits.push((val >>> i) & 1);
    }
  };

  pushBits(0b0100, 4);
  pushBits(payload.length, version <= 9 ? 8 : 16);
  for (let i = 0; i < payload.length; i++) {
    pushBits(payload[i], 8);
  }

  const capacityBits = dataCapacityCodewords * 8;
  const terminatorLen = Math.min(4, capacityBits - bits.length);
  pushBits(0, terminatorLen);

  while (bits.length % 8 !== 0) {
    bits.push(0);
  }

  const dataCodewords = new Uint8Array(dataCapacityCodewords);
  for (let i = 0; i < bits.length / 8; i++) {
    let b = 0;
    for (let j = 0; j < 8; j++) {
      b = (b << 1) | bits[i * 8 + j];
    }
    dataCodewords[i] = b;
  }

  let padIdx = bits.length / 8;
  let padToggle = 0;
  while (padIdx < dataCapacityCodewords) {
    dataCodewords[padIdx++] = padToggle === 0 ? 0xec : 0x11;
    padToggle ^= 1;
  }

  // Split into blocks, compute Reed-Solomon EC codewords, and interleave
  const numBlocks = EC_BLOCKS_TABLE[(version - 1) * 4 + ecIdx];
  const totalEcCodewords = EC_CODEWORDS_TABLE[(version - 1) * 4 + ecIdx];
  const ecPerBlock = totalEcCodewords / numBlocks;
  const numShortBlocks = numBlocks - (totalCodewords % numBlocks);
  const shortDataLen = Math.floor(totalCodewords / numBlocks) - ecPerBlock;
  const rsDivisor = buildRsDivisor(ecPerBlock);

  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;

  for (let b = 0; b < numBlocks; b++) {
    const blockLen = shortDataLen + (b < numShortBlocks ? 0 : 1);
    const block = dataCodewords.subarray(offset, offset + blockLen);
    offset += blockLen;
    dataBlocks.push(block);
    ecBlocks.push(computeRsRemainder(block, rsDivisor));
  }

  const finalCodewords = new Uint8Array(totalCodewords);
  let outPos = 0;
  const maxDataLen = shortDataLen + (numShortBlocks < numBlocks ? 1 : 0);
  for (let col = 0; col < maxDataLen; col++) {
    for (let b = 0; b < numBlocks; b++) {
      if (col < dataBlocks[b].length) {
        finalCodewords[outPos++] = dataBlocks[b][col];
      }
    }
  }
  for (let col = 0; col < ecPerBlock; col++) {
    for (let b = 0; b < numBlocks; b++) {
      finalCodewords[outPos++] = ecBlocks[b][col];
    }
  }

  // Construct base matrix & function patterns
  const size = version * 4 + 17;
  const baseModules = new Uint8Array(size * size);
  const reserved = new Uint8Array(size * size);

  const setFunction = (r: number, c: number, dark: boolean) => {
    if (r < 0 || r >= size || c < 0 || c >= size) return;
    baseModules[r * size + c] = dark ? 1 : 0;
    reserved[r * size + c] = 1;
  };

  const drawFinder = (top: number, left: number) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const inOuter =
          dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6 &&
          (dr === 0 || dr === 6 || dc === 0 || dc === 6);
        const inCenter = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        setFunction(top + dr, left + dc, inOuter || inCenter);
      }
    }
  };

  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    const dark = i % 2 === 0;
    setFunction(6, i, dark);
    setFunction(i, 6, dark);
  }

  // Alignment patterns
  const alignCoords = getAlignmentCoords(version);
  for (let i = 0; i < alignCoords.length; i++) {
    for (let j = 0; j < alignCoords.length; j++) {
      const isFinderCorner =
        (i === 0 && j === 0) ||
        (i === 0 && j === alignCoords.length - 1) ||
        (i === alignCoords.length - 1 && j === 0);
      if (isFinderCorner) continue;

      const cr = alignCoords[i];
      const cc = alignCoords[j];
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dark =
            Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          setFunction(cr + dr, cc + dc, dark);
        }
      }
    }
  }

  // Version info (Versions >= 7)
  if (version >= 7) {
    const vBits = getEncodedVersionBits(version);
    for (let i = 0; i < 18; i++) {
      const r = Math.floor(i / 3);
      const c = (i % 3) + size - 11;
      const dark = ((vBits >>> i) & 1) === 1;
      setFunction(r, c, dark);
      setFunction(c, r, dark);
    }
  }

  // Reserve format info positions before placing data
  drawFormatInfo(baseModules, reserved, size, ecLevel, 0);

  // Zigzag placement of data + EC bits
  let inc = -1;
  let row = size - 1;
  let bitIndex = 7;
  let byteIndex = 0;

  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    while (true) {
      for (let dc = 0; dc < 2; dc++) {
        const c = col - dc;
        if (!reserved[row * size + c]) {
          let dark = 0;
          if (byteIndex < finalCodewords.length) {
            dark = (finalCodewords[byteIndex] >>> bitIndex) & 1;
          }
          baseModules[row * size + c] = dark;
          bitIndex--;
          if (bitIndex < 0) {
            byteIndex++;
            bitIndex = 7;
          }
        }
      }
      row += inc;
      if (row < 0 || row >= size) {
        row -= inc;
        inc = -inc;
        break;
      }
    }
  }

  // Evaluate all 8 mask patterns and choose minimum ISO/IEC 18004 penalty
  let bestMask = 0;
  let bestPenalty = Number.POSITIVE_INFINITY;
  let bestModules = baseModules;

  for (let mask = 0; mask < 8; mask++) {
    const candidate = new Uint8Array(baseModules);
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!reserved[r * size + c] && shouldInvertForMask(mask, r, c)) {
          candidate[r * size + c] ^= 1;
        }
      }
    }
    drawFormatInfo(candidate, reserved, size, ecLevel, mask);
    const penalty = computeMaskPenalty(candidate, size);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestMask = mask;
      bestModules = candidate;
    }
  }

  return {
    version,
    size,
    mask: bestMask,
    modules: bestModules,
  };
}

function escapeXmlAttr(val: string): string {
  return val
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function renderQrSvg(text: string, options: QrSvgOptions = {}): string {
  const ecLevel = options.errorCorrectionLevel ?? 'M';
  const margin = Math.max(0, Math.floor(options.margin ?? 1));
  const width = Math.max(64, Math.floor(options.width ?? 200));
  const dark = escapeXmlAttr(options.color?.dark ?? '#0f172a');
  const light = escapeXmlAttr(options.color?.light ?? '#ffffff');

  const { size, modules } = encodeQrMatrix(text, ecLevel);
  const viewSize = size + margin * 2;

  const pathParts: string[] = [];
  for (let r = 0; r < size; r++) {
    let c = 0;
    while (c < size) {
      if (modules[r * size + c] === 1) {
        let run = 1;
        while (c + run < size && modules[r * size + c + run] === 1) {
          run++;
        }
        pathParts.push(`M${c + margin} ${r + margin}h${run}v1h-${run}z`);
        c += run;
      } else {
        c++;
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${width}" viewBox="0 0 ${viewSize} ${viewSize}" shape-rendering="crispEdges"><rect width="${viewSize}" height="${viewSize}" fill="${light}"/><path fill="${dark}" d="${pathParts.join('')}"/></svg>`;
}
