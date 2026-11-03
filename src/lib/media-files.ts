/**
 * File-level helpers for gallery media (no Next, no database):
 *
 * - `sniffMime`: what a file really is, from its first bytes (S1: never trust the declared type).
 * - `extFor`: the file extension for a verified type (never taken from the uploader's file name).
 * - `parseExif` / `readExifTags`: a small EXIF reader (orientation, capture time).
 * - `stripJpegMetadata`: a JPEG without GPS, camera serials, XMP/IPTC or embedded extra images,
 *   keeping only orientation and capture time, for originals shown to guests (ADR-0032).
 */

/** Enough bytes to tell every supported type apart. */
export const SNIFF_BYTES = 64;

const ascii = (b: Uint8Array, start: number, end: number) => String.fromCharCode(...b.subarray(start, end));

const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis"]);
const HEIF_BRANDS = new Set(["mif1", "msf1"]);
const QT_BRANDS = new Set(["qt  "]);
const MP4_BRANDS = new Set(["isom", "iso2", "iso3", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "dash", "M4V ", "M4VP", "MSNV", "mmp4", "3gp4", "3gp5", "3g2a", "f4v "]);

/** The real type of a file from its first bytes, or null when it isn't one we accept. */
export function sniffMime(head: Uint8Array): string | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.length >= 8 && head[0] === 0x89 && ascii(head, 1, 4) === "PNG" && head[4] === 0x0d && head[5] === 0x0a && head[6] === 0x1a && head[7] === 0x0a) return "image/png";
  if (head.length >= 12 && ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 12) === "WEBP") return "image/webp";
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return "video/webm";
  if (head.length >= 12 && ascii(head, 4, 8) === "ftyp") {
    const major = ascii(head, 8, 12);
    if (HEIC_BRANDS.has(major)) return "image/heic";
    if (HEIF_BRANDS.has(major)) return "image/heif";
    if (QT_BRANDS.has(major)) return "video/quicktime";
    if (MP4_BRANDS.has(major)) return "video/mp4";
    return null;
  }
  // Old QuickTime files start with an atom other than ftyp.
  if (head.length >= 8 && ["moov", "mdat", "wide", "free", "skip", "pnot"].includes(ascii(head, 4, 8))) return "video/quicktime";
  return null;
}

/** Declared and sniffed types that mean the same file family (HEIC/HEIF, MP4/QuickTime). */
export function sameFamily(declared: string, sniffed: string) {
  if (declared === sniffed) return true;
  const heif = ["image/heic", "image/heif"];
  const isoVideo = ["video/mp4", "video/quicktime"];
  return (heif.includes(declared) && heif.includes(sniffed)) || (isoVideo.includes(declared) && isoVideo.includes(sniffed));
}

const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
};

/** File extension for a verified type ("bin" for anything else). */
export function extFor(mime: string) {
  return EXT[mime] ?? "bin";
}

// ---------------------------------------------------------------------------
// EXIF
// ---------------------------------------------------------------------------

export type ExifTags = { ifd0: Map<number, string | number>; sub: Map<number, string | number> };

/** Parses IFD0 and the Exif sub-IFD of a raw EXIF block (with or without the "Exif\0\0" header). */
export function parseExif(exif: Uint8Array | undefined | null): ExifTags | null {
  if (!exif || exif.length < 14) return null;
  const buf = Buffer.from(exif.buffer, exif.byteOffset, exif.byteLength);
  let base = 0;
  if (buf.subarray(0, 6).toString("latin1") === "Exif\0\0") base = 6;
  const order = buf.subarray(base, base + 2).toString("latin1");
  const le = order === "II";
  if (!le && order !== "MM") return null;
  const u16 = (o: number) => (o >= 0 && o + 2 <= buf.length ? (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o)) : -1);
  const u32 = (o: number) => (o >= 0 && o + 4 <= buf.length ? (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o)) : -1);
  if (u16(base + 2) !== 42) return null;

  const readIfd = (offset: number) => {
    const tags = new Map<number, string | number>();
    if (offset < 0) return tags;
    const start = base + offset;
    const n = u16(start);
    if (n < 0 || n > 500) return tags;
    for (let i = 0; i < n; i++) {
      const e = start + 2 + i * 12;
      const tag = u16(e);
      const type = u16(e + 2);
      const cnt = u32(e + 4);
      if (tag < 0 || cnt < 0) break;
      if (type === 2) {
        const at = cnt > 4 ? base + u32(e + 8) : e + 8;
        if (at < 0 || at + cnt > buf.length) continue;
        tags.set(tag, buf.subarray(at, at + cnt).toString("latin1").replace(/\0+$/, ""));
      } else if (type === 3) tags.set(tag, u16(e + 8));
      else if (type === 4) tags.set(tag, u32(e + 8));
    }
    return tags;
  };

  const ifd0 = readIfd(u32(base + 4));
  const exifPtr = ifd0.get(0x8769);
  const sub = typeof exifPtr === "number" ? readIfd(exifPtr) : new Map<number, string | number>();
  return { ifd0, sub };
}

/** The tags we keep on stripped copies: orientation and capture time (with its UTC offset). */
export function readExifTags(exif: Uint8Array | undefined | null): { orientation: number | null; dateTime: string | null; offset: string | null } {
  const t = parseExif(exif);
  if (!t) return { orientation: null, dateTime: null, offset: null };
  const o = t.ifd0.get(0x0112);
  const raw = t.sub.get(0x9003) ?? t.sub.get(0x9004) ?? t.ifd0.get(0x0132);
  const dateTime = typeof raw === "string" && /^\d{4}:\d{2}:\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(raw) ? raw.slice(0, 19).replace("T", " ") : null;
  const off = t.sub.get(0x9011);
  return {
    orientation: typeof o === "number" && o >= 1 && o <= 8 ? o : null,
    dateTime,
    offset: typeof off === "string" && /^[+-]\d{2}:\d{2}$/.test(off) ? off : null,
  };
}

/** A minimal EXIF APP1 payload ("Exif\0\0" + little-endian TIFF) with only the given tags. */
export function buildMinimalExif(tags: { orientation: number | null; dateTime: string | null; offset: string | null }): Buffer | null {
  const ifd0: { tag: number; type: number; count: number; value: number }[] = [];
  const subEntries: { tag: number; text: string }[] = [];
  if (tags.dateTime) subEntries.push({ tag: 0x9003, text: tags.dateTime });
  if (tags.dateTime && tags.offset) subEntries.push({ tag: 0x9011, text: tags.offset });
  if (tags.orientation) ifd0.push({ tag: 0x0112, type: 3, count: 1, value: tags.orientation });
  if (ifd0.length === 0 && subEntries.length === 0) return null;
  const hasSub = subEntries.length > 0;
  const ifd0Count = ifd0.length + (hasSub ? 1 : 0);
  const ifd0Size = 2 + ifd0Count * 12 + 4;
  const subOffset = 8 + ifd0Size;
  const subSize = hasSub ? 2 + subEntries.length * 12 + 4 : 0;
  let dataOffset = subOffset + subSize;
  const strings: Buffer[] = [];
  const subBuilt = subEntries.map((s) => {
    const bytes = Buffer.from(`${s.text}\0`, "latin1");
    const entry = { tag: s.tag, count: bytes.length, at: bytes.length > 4 ? dataOffset : -1, bytes };
    if (bytes.length > 4) {
      strings.push(bytes);
      dataOffset += bytes.length;
    }
    return entry;
  });
  const tiff = Buffer.alloc(dataOffset);
  tiff.write("II", 0, "latin1");
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  let p = 8;
  tiff.writeUInt16LE(ifd0Count, p);
  p += 2;
  const all = [...ifd0];
  if (hasSub) all.push({ tag: 0x8769, type: 4, count: 1, value: subOffset });
  all.sort((a, b) => a.tag - b.tag);
  for (const e of all) {
    tiff.writeUInt16LE(e.tag, p);
    tiff.writeUInt16LE(e.type, p + 2);
    tiff.writeUInt32LE(e.count, p + 4);
    if (e.type === 3) tiff.writeUInt16LE(e.value, p + 8);
    else tiff.writeUInt32LE(e.value, p + 8);
    p += 12;
  }
  tiff.writeUInt32LE(0, p);
  if (hasSub) {
    p = subOffset;
    tiff.writeUInt16LE(subBuilt.length, p);
    p += 2;
    for (const e of subBuilt) {
      tiff.writeUInt16LE(e.tag, p);
      tiff.writeUInt16LE(2, p + 2);
      tiff.writeUInt32LE(e.count, p + 4);
      if (e.at >= 0) {
        tiff.writeUInt32LE(e.at, p + 8);
        e.bytes.copy(tiff, e.at);
      } else e.bytes.copy(tiff, p + 8);
      p += 12;
    }
    tiff.writeUInt32LE(0, p);
  }
  return Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
}

// ---------------------------------------------------------------------------
// JPEG metadata stripping (lossless: the image data is copied as is)
// ---------------------------------------------------------------------------

export class NotJpegError extends Error {}

/**
 * Copies a JPEG keeping only what's needed to display it (quantisation/Huffman tables, frame and
 * scans, JFIF, ICC profile, Adobe colour info) plus a fresh EXIF block with just the orientation
 * and capture time. Drops other EXIF (GPS, camera serials, maker notes), XMP, IPTC, comments
 * and anything after the main image (MPF extra images, which carry their own EXIF).
 */
export function stripJpegMetadata(input: Uint8Array): Buffer {
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const n = buf.length;
  if (n < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) throw new NotJpegError("not a jpeg");
  const head: Buffer[] = [];
  const body: Buffer[] = [];
  let exif: Buffer | null = null;
  let pos = 2;
  let ended = false;
  while (pos < n) {
    if (buf[pos] !== 0xff) throw new NotJpegError("bad marker");
    while (pos + 1 < n && buf[pos + 1] === 0xff) pos++; // fill bytes
    if (pos + 1 >= n) break;
    const marker = buf[pos + 1];
    if (marker === 0xd9) {
      body.push(buf.subarray(pos, pos + 2));
      ended = true;
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      body.push(buf.subarray(pos, pos + 2));
      pos += 2;
      continue;
    }
    if (pos + 4 > n) throw new NotJpegError("truncated");
    const len = buf.readUInt16BE(pos + 2);
    if (len < 2 || pos + 2 + len > n) throw new NotJpegError("truncated");
    const seg = buf.subarray(pos, pos + 2 + len);
    const payload = seg.subarray(4);
    const startsWith = (s: string) => payload.subarray(0, s.length).toString("latin1") === s;
    let keep = true;
    let toHead = false;
    if (marker === 0xe0) {
      keep = startsWith("JFIF\0") || startsWith("JFXX\0");
      toHead = true;
    } else if (marker === 0xe1) {
      if (!exif && startsWith("Exif\0\0")) exif = Buffer.from(payload);
      keep = false;
    } else if (marker === 0xe2) keep = startsWith("ICC_PROFILE\0");
    else if (marker === 0xee) keep = startsWith("Adobe");
    else if ((marker >= 0xe3 && marker <= 0xef) || marker === 0xfe) keep = false;
    if (keep) (toHead && body.length === 0 ? head : body).push(seg);
    pos += 2 + len;
    if (marker === 0xda) {
      // Entropy-coded data runs to the next real marker (not a stuffed 00, RSTn or fill byte).
      let p = pos;
      while (p + 1 < n && !(buf[p] === 0xff && buf[p + 1] !== 0x00 && buf[p + 1] !== 0xff && !(buf[p + 1] >= 0xd0 && buf[p + 1] <= 0xd7))) p++;
      if (p + 1 >= n) p = n;
      body.push(buf.subarray(pos, p));
      pos = p;
    }
  }
  if (!ended) body.push(Buffer.from([0xff, 0xd9]));
  const minimal = buildMinimalExif(readExifTags(exif));
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8]), ...head];
  if (minimal) {
    const len = Buffer.alloc(4);
    len[0] = 0xff;
    len[1] = 0xe1;
    len.writeUInt16BE(minimal.length + 2, 2);
    parts.push(len, minimal);
  }
  parts.push(...body);
  return Buffer.concat(parts);
}

/** Reads the first `n` bytes of a stream and cancels the rest. */
export async function readStreamHead(stream: ReadableStream<Uint8Array>, n = SNIFF_BYTES): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  try {
    while (got < n) {
      const { value, done } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      got += value.length;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const out = new Uint8Array(Math.min(n, got));
  let at = 0;
  for (const c of chunks) {
    const take = Math.min(c.length, out.length - at);
    out.set(c.subarray(0, take), at);
    at += take;
    if (at >= out.length) break;
  }
  return out;
}
