/**
 * Single-frame GIF89a encoder for snapshot export.
 * Chrome canvas cannot emit image/gif, so this builds an indexed GIF from RGBA.
 *
 * LZW follows the classic GIFCOMPR / compress.c bit-size bump rules used by
 * gifenc (Weiner / Nordberg / DesLauriers), which decoders expect.
 */

function encodeRgbaToGif(rgba, width, height) {
  return encodeRgbaFramesToGif(
    [{ rgba, delayCs: 0 }],
    width,
    height,
    { loop: false }
  );
}

/**
 * Multi-frame animated GIF89a.
 * @param {Array<{ rgba: Uint8Array|Uint8ClampedArray, delayCs?: number, delaySeconds?: number }>} frames
 * @param {number} width
 * @param {number} height
 * @param {{ loop?: boolean }} [options]
 */
function encodeRgbaFramesToGif(frames, width, height, options = {}) {
  const w = width | 0;
  const h = height | 0;
  if (!Array.isArray(frames) || frames.length === 0) {
    throw new Error("GIF encode expects at least one frame");
  }
  if (w <= 0 || h <= 0) {
    throw new Error("Invalid GIF dimensions");
  }

  const loop = options.loop !== false;
  const out = [];
  writeBytes(out, asciiBytes("GIF89a"));
  writeUint16(out, w);
  writeUint16(out, h);
  // No global color table; each frame uses a local table.
  out.push(0x70); // color resolution 8 bits, no GCT
  out.push(0);
  out.push(0);

  if (loop && frames.length > 1) {
    // Netscape Application Extension — loop forever
    writeBytes(out, [0x21, 0xff, 0x0b]);
    writeBytes(out, asciiBytes("NETSCAPE2.0"));
    writeBytes(out, [0x03, 0x01, 0x00, 0x00, 0x00]);
  }

  for (const frame of frames) {
    const rgba = frame.rgba;
    if (!(rgba instanceof Uint8ClampedArray || rgba instanceof Uint8Array)) {
      throw new Error("GIF encode expects RGBA bytes");
    }
    if (rgba.length < w * h * 4) {
      throw new Error("Invalid GIF frame size");
    }

    let delayCs =
      frame.delayCs != null
        ? Math.round(Number(frame.delayCs))
        : Math.round((Number(frame.delaySeconds) || 0) * 100);
    if (!Number.isFinite(delayCs) || delayCs < 0) delayCs = 0;
    // Browsers treat 0–1 cs as ~10cs; clamp animated delays to ≥2 (0.02s).
    if (frames.length > 1 && delayCs < 2) delayCs = 2;
    if (delayCs > 65535) delayCs = 65535;

    const { palette, indices, colorCount } = quantizeRgbaToGifPalette(
      rgba,
      w,
      h
    );
    let lctSize = 0;
    while (2 ** (lctSize + 1) < colorCount && lctSize < 7) lctSize += 1;
    const lctColors = 2 ** (lctSize + 1);
    const colorDepth = lctSize + 1;

    // Graphic Control Extension: disposal 2 (restore to background), no transparent
    writeBytes(out, [
      0x21,
      0xf9,
      0x04,
      0x08, // packed: disposal 2
      delayCs & 255,
      (delayCs >> 8) & 255,
      0x00,
      0x00,
    ]);

    out.push(0x2c);
    writeUint16(out, 0);
    writeUint16(out, 0);
    writeUint16(out, w);
    writeUint16(out, h);
    out.push(0x80 | lctSize); // local color table

    for (let i = 0; i < lctColors * 3; i += 1) {
      out.push(i < palette.length ? palette[i] : 0);
    }

    writeBytes(out, lzwEncode(indices, colorDepth));
  }

  out.push(0x3b);
  return Uint8Array.from(out);
}

function quantizeRgbaToGifPalette(rgba, width, height) {
  const counts = new Map();
  const pixelCount = width * height;
  const step = Math.max(1, Math.floor(Math.sqrt(pixelCount / 20000)));
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      const key = packRgb(rgba[i], rgba[i + 1], rgba[i + 2]);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }

  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const chosen = ranked.slice(0, 256).map(([key]) => key);
  if (chosen.length === 0) chosen.push(packRgb(255, 255, 255));

  const colorCount = chosen.length;
  const palette = new Uint8Array(colorCount * 3);
  const indexByKey = new Map();
  const paletteRgb = new Array(colorCount);
  for (let i = 0; i < colorCount; i += 1) {
    const key = chosen[i];
    indexByKey.set(key, i);
    const r = (key >> 16) & 255;
    const g = (key >> 8) & 255;
    const b = key & 255;
    palette[i * 3] = r;
    palette[i * 3 + 1] = g;
    palette[i * 3 + 2] = b;
    paletteRgb[i] = [r, g, b];
  }

  const indices = new Uint8Array(pixelCount);
  const nearestCache = new Map();
  for (let p = 0, i = 0; p < pixelCount; p += 1, i += 4) {
    const key = packRgb(rgba[i], rgba[i + 1], rgba[i + 2]);
    let idx = indexByKey.get(key);
    if (idx == null) {
      idx = nearestCache.get(key);
      if (idx == null) {
        idx = nearestPaletteIndex(rgba[i], rgba[i + 1], rgba[i + 2], paletteRgb);
        nearestCache.set(key, idx);
      }
    }
    indices[p] = idx;
  }

  return { palette, indices, colorCount };
}

function nearestPaletteIndex(r, g, b, paletteRgb) {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < paletteRgb.length; i += 1) {
    const pr = paletteRgb[i][0] - r;
    const pg = paletteRgb[i][1] - g;
    const pb = paletteRgb[i][2] - b;
    const dist = pr * pr + pg * pg + pb * pb;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
      if (dist === 0) break;
    }
  }
  return best;
}

function packRgb(r, g, b) {
  return ((r & 255) << 16) | ((g & 255) << 8) | (b & 255);
}

const LZW_BITS = 12;
const LZW_HSIZE = 5003;
const LZW_MASKS = [
  0x0000, 0x0001, 0x0003, 0x0007, 0x000f, 0x001f, 0x003f, 0x007f, 0x00ff,
  0x01ff, 0x03ff, 0x07ff, 0x0fff, 0x1fff, 0x3fff, 0x7fff, 0xffff,
];

/**
 * @param {Uint8Array} pixels index stream
 * @param {number} colorDepth bits for the color table (2–8)
 * @returns {number[]} minCodeSize byte + length-prefixed sub-blocks + terminator 0
 */
function lzwEncode(pixels, colorDepth) {
  const initCodeSize = Math.max(2, colorDepth);
  const out = [];
  out.push(initCodeSize);

  const htab = new Int32Array(LZW_HSIZE);
  const codetab = new Int32Array(LZW_HSIZE);
  const accum = new Uint8Array(256);
  htab.fill(-1);

  const gInitBits = initCodeSize + 1;
  let clearFlg = false;
  let nBits = gInitBits;
  let maxcode = (1 << nBits) - 1;
  const clearCode = 1 << initCodeSize;
  const eofCode = clearCode + 1;
  let freeEnt = clearCode + 2;
  let aCount = 0;
  let curAccum = 0;
  let curBits = 0;

  let hshift = 0;
  for (let fcode = LZW_HSIZE; fcode < 65536; fcode *= 2) hshift += 1;
  hshift = 8 - hshift;

  function flushPacket() {
    if (aCount > 0) {
      out.push(aCount);
      for (let i = 0; i < aCount; i += 1) out.push(accum[i]);
      aCount = 0;
    }
  }

  function output(code) {
    curAccum &= LZW_MASKS[curBits];
    if (curBits > 0) curAccum |= code << curBits;
    else curAccum = code;
    curBits += nBits;

    while (curBits >= 8) {
      accum[aCount++] = curAccum & 0xff;
      if (aCount >= 254) flushPacket();
      curAccum >>= 8;
      curBits -= 8;
    }

    if (freeEnt > maxcode || clearFlg) {
      if (clearFlg) {
        nBits = gInitBits;
        maxcode = (1 << nBits) - 1;
        clearFlg = false;
      } else {
        nBits += 1;
        maxcode = nBits === LZW_BITS ? 1 << nBits : (1 << nBits) - 1;
      }
    }

    if (code === eofCode) {
      while (curBits > 0) {
        accum[aCount++] = curAccum & 0xff;
        if (aCount >= 254) flushPacket();
        curAccum >>= 8;
        curBits -= 8;
      }
      flushPacket();
    }
  }

  output(clearCode);

  let ent = pixels[0];
  for (let idx = 1; idx < pixels.length; idx += 1) {
    const c = pixels[idx];
    const fcode = (c << LZW_BITS) + ent;
    let i = (c << hshift) ^ ent;
    if (htab[i] === fcode) {
      ent = codetab[i];
      continue;
    }

    let disp = i === 0 ? 1 : LZW_HSIZE - i;
    let found = false;
    while (htab[i] >= 0) {
      i -= disp;
      if (i < 0) i += LZW_HSIZE;
      if (htab[i] === fcode) {
        ent = codetab[i];
        found = true;
        break;
      }
    }
    if (found) continue;

    output(ent);
    ent = c;
    if (freeEnt < 1 << LZW_BITS) {
      codetab[i] = freeEnt;
      freeEnt += 1;
      htab[i] = fcode;
    } else {
      htab.fill(-1);
      freeEnt = clearCode + 2;
      clearFlg = true;
      output(clearCode);
    }
  }

  output(ent);
  output(eofCode);
  out.push(0); // block terminator
  return out;
}

function writeUint16(out, value) {
  out.push(value & 255);
  out.push((value >> 8) & 255);
}

function writeBytes(out, bytes) {
  for (let i = 0; i < bytes.length; i += 1) out.push(bytes[i]);
}

function asciiBytes(text) {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i);
  return out;
}
