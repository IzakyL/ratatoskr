const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export interface PngSize {
  width: number;
  height: number;
}

/**
 * Reads width/height out of a PNG's IHDR chunk, which is required to be the
 * first chunk. Returns null if the bytes are not a PNG at all -- enough of a
 * check to keep people from uploading executables as their skin.
 */
export function readPngSize(bytes: Uint8Array): PngSize | null {
  if (bytes.length < 24) return null;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return null;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunkType = String.fromCharCode(...bytes.slice(12, 16));
  if (chunkType !== 'IHDR') return null;

  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * Skins are 64x64, or 64x32 for the pre-1.8 layout. HD skins keep the same
 * aspect ratio at a larger scale, so accept any power-of-two multiple.
 */
export function isValidSkinSize({ width, height }: PngSize): boolean {
  if (width < 64 || width > 1024 || !isPowerOfTwo(width)) return false;
  return height === width || height === width / 2;
}

/** Capes have no single canonical size across versions; just bound them. */
export function isValidCapeSize({ width, height }: PngSize): boolean {
  return width >= 22 && height >= 17 && width <= 1024 && height <= 1024;
}

function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}
