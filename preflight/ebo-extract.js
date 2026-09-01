#!/usr/bin/env node
// Decrypts Bohemia "EBO" (Encrypted Bank of Files) into a plain .pbo.
// Port of the reference RC4/EBO decryptor from testcode.md (C++) to Node.js.
// Usage:
//   node tools/ebo-extract.js <file.ebo | directory> [outDir] [--arma3] [--keep-ext]

const fs = require('fs');
const path = require('path');

const DAYZ_KEY = Uint8Array.from([
  0x8F, 0x06, 0xAD, 0x83, 0xD6, 0xCD, 0xC3, 0x3F,
  0xE4, 0x19, 0xBF, 0xEC, 0x3F, 0x26, 0x7C, 0x43,
]);
const ARMA3_KEY = Uint8Array.from([
  0x0E, 0xE2, 0x6D, 0x27, 0x95, 0x69, 0xC5, 0x9A,
  0x0D, 0xCF, 0x6D, 0x55, 0x03, 0xBA, 0x80, 0xD9,
]);

const MAGIC_MANTISSA = Math.fround(0.000000000465661);

// --- CRandomMantissa ---

class RandomMantissa {
  constructor() {
    this.seed = 0;
  }

  setSeed(seed) {
    this.seed = seed | 0;
  }

  next() {
    const newSeed = (12345 - Math.imul(1043968403, this.seed)) | 0;
    this.seed = newSeed & 0x7fffffff;
    return Math.fround(Math.fround(this.seed) * MAGIC_MANTISSA);
  }
}

// --- CRC4 ---

class RC4 {
  constructor(key, bufferSize) {
    this.defaultKeyInts = bytesToUint32LE(key);
    this.rng = new RandomMantissa();
    this.seed = computeInitialSeed(bufferSize);

    this.defaultState = new Int32Array(256);
    for (let i = 0; i < 256; i++) this.defaultState[i] = i;
  }

  getChunkSeed(chunkPosition) {
    const seedXor = BigInt(chunkPosition) ^ BigInt(this.seed);
    this.rng.setSeed(Number(BigInt.asIntN(32, seedXor)));

    const next = this.rng.next();
    let t = Math.fround(next * 256.0);
    t = Math.fround(t - 0.5);
    t = Math.fround(t + 12582912.0);

    const asInt = t | 0;
    const masked = asInt & 0x7fffff;

    let result = (masked + 4290772992 + 256) | 0;
    if (result < 256) result = 256;
    if (result > 511) result = 511;
    return result;
  }

  decryptChunk(buffer, offset, chunkSize, chunkPosition) {
    const tempState = Int32Array.from(this.defaultState);

    const notSeed32 = ~this.seed;
    const rhs32u = Number(
      BigInt.asUintN(32, BigInt(chunkPosition) ^ BigInt(notSeed32))
    );

    const keyInts = new Uint32Array(4);
    for (let i = 0; i < 4; i++) {
      keyInts[i] = (this.defaultKeyInts[i] ^ rhs32u) >>> 0;
    }
    const keyBytes = new Uint8Array(16);
    for (let i = 0; i < 4; i++) {
      keyBytes[i * 4 + 0] = keyInts[i] & 0xff;
      keyBytes[i * 4 + 1] = (keyInts[i] >>> 8) & 0xff;
      keyBytes[i * 4 + 2] = (keyInts[i] >>> 16) & 0xff;
      keyBytes[i * 4 + 3] = (keyInts[i] >>> 24) & 0xff;
    }

    // Key scheduling
    let tempIndex = 0;
    for (let i = 0; i < 256; i++) {
      tempIndex = (tempIndex + tempState[i] + keyBytes[i % 16]) & 0xff;
      swap(tempState, tempIndex, i);
    }

    // Pseudo random obfuscation layer
    let srcIdx = 0;
    let dstIdx = 0;
    const seedCount = this.getChunkSeed(chunkPosition);
    for (let i = 0; i < seedCount; i++) {
      srcIdx++;
      dstIdx = (dstIdx + tempState[srcIdx & 0xff]) & 0xff;
      swap(tempState, srcIdx & 0xff, dstIdx & 0xff);
    }

    // Swap indices
    [srcIdx, dstIdx] = [dstIdx, srcIdx];

    // Decryption
    for (let i = 0; i < chunkSize; i++) {
      srcIdx++;
      dstIdx = (dstIdx + tempState[srcIdx & 0xff]) & 0xff;
      swap(tempState, srcIdx & 0xff, dstIdx & 0xff);

      const t = (tempState[srcIdx & 0xff] + tempState[dstIdx & 0xff]) & 0xff;
      buffer[offset + i] ^= tempState[t];
    }
  }
}

function swap(buf, a, b) {
  const tmp = buf[a];
  buf[a] = buf[b];
  buf[b] = tmp;
}

function bytesToUint32LE(bytes) {
  const out = new Uint32Array(4);
  for (let i = 0; i < 4; i++) {
    out[i] =
      (bytes[i * 4] |
        (bytes[i * 4 + 1] << 8) |
        (bytes[i * 4 + 2] << 16) |
        (bytes[i * 4 + 3] << 24)) >>>
      0;
  }
  return out;
}

function computeInitialSeed(bufferSize) {
  const bi = BigInt(bufferSize);
  const lowByte = bi & 0xffn;
  const asInt8 = lowByte >= 128n ? lowByte - 256n : lowByte;
  const shift1 = -asInt8 & 7n;
  const shift2 = (bi >> 3n) & 7n;

  const left = bi << shift1;
  const right = bi >> shift2;
  const orVal = left | right;
  const xorVal = bi ^ orVal;

  return Number(BigInt.asIntN(32, xorVal));
}

// --- EBO parsing ---

const PBO_HEADER_SIZE = 21; // sizeof(SPBOHeader)
const CHUNK_SIZE = 4096;

function computeHeaderSize(buf) {
  let pos = PBO_HEADER_SIZE;
  for (;;) {
    const c = buf[pos];
    pos += 1;
    if (c === 0) break;
    while (buf[pos] !== 0) pos += 1;
    pos += 1; // consume the terminating null
  }
  return pos;
}

function buildChunkPlan(eboSize, headerSize) {
  const chunkCount = Math.floor((eboSize - headerSize + 4095) / CHUNK_SIZE);
  const chunks = [];

  let offset = headerSize;
  let filePos = 0;

  const firstSize = CHUNK_SIZE - headerSize;
  chunks.push({ offset, size: firstSize, position: 0 });
  offset += firstSize;
  filePos += CHUNK_SIZE;

  for (let i = 1; i < chunkCount - 1; i++) {
    chunks.push({ offset, size: CHUNK_SIZE, position: filePos });
    offset += CHUNK_SIZE;
    filePos += CHUNK_SIZE;
  }

  const lastSize = (eboSize - headerSize) % CHUNK_SIZE;
  chunks.push({ offset, size: lastSize, position: filePos });

  return chunks;
}

function decryptEbo(buf, key) {
  const eboSize = buf.length;
  const headerSize = computeHeaderSize(buf);
  const chunks = buildChunkPlan(eboSize, headerSize);

  const rc4 = new RC4(key, eboSize);
  for (const chunk of chunks) {
    if (chunk.size <= 0) continue;
    rc4.decryptChunk(buf, chunk.offset, chunk.size, chunk.position);
  }

  return buf;
}

// --- CLI ---

function toPboPath(eboPath) {
  const dir = path.dirname(eboPath);
  const ext = path.extname(eboPath);
  const base = path.basename(eboPath, ext);
  return path.join(dir, `${base}.pbo`);
}

function extractFile(eboPath, outDir, key) {
  const buf = fs.readFileSync(eboPath);
  decryptEbo(buf, key);

  const outPath = outDir
    ? path.join(outDir, path.basename(toPboPath(eboPath)))
    : toPboPath(eboPath);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buf);
  console.log(`Decrypted: ${eboPath} -> ${outPath}`);
}

function findEboFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findEboFiles(full));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.ebo')) {
      results.push(full);
    }
  }
  return results;
}

function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const positional = args.filter((a) => !a.startsWith('--'));

  const key = flags.has('--arma3') ? ARMA3_KEY : DAYZ_KEY;

  if (positional.length === 0) {
    console.error(
      'Usage: node tools/ebo-extract.js <file.ebo | directory> [outDir] [--arma3]'
    );
    process.exit(1);
  }

  const input = positional[0];
  const outDir = positional[1] || null;

  const stat = fs.statSync(input);
  const files = stat.isDirectory() ? findEboFiles(input) : [input];

  if (files.length === 0) {
    console.error(`No .ebo files found under: ${input}`);
    process.exit(1);
  }

  let failures = 0;
  for (const file of files) {
    try {
      extractFile(file, outDir, key);
    } catch (err) {
      failures++;
      console.error(`Failed: ${file} - ${err.message}`);
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} of ${files.length} file(s) failed.`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { decryptEbo, computeHeaderSize, buildChunkPlan, DAYZ_KEY, ARMA3_KEY };
