/**
 * The type of an uploaded file is decided from its first bytes, never from the client's Content-Type or file name:
 * Tabula serves attachments from its own origin, so an HTML or SVG file posing as an image could read the token
 * from the page. Only the formats below are accepted.
 */
export type MediaKind = 'image' | 'video' | 'audio';
export type Sniffed = { kind: MediaKind; mime: string; ext: string };

/** How many leading bytes sniff() needs. */
export const SNIFF_BYTES = 64;

const ascii = (b: Buffer, start: number, end: number) => b.subarray(start, end).toString('latin1');

export function sniff(head: Buffer, declared?: string): Sniffed | null {
  const b = head;
  if (b.length < 4) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: 'image', mime: 'image/jpeg', ext: 'jpg' };
  if (b[0] === 0x89 && ascii(b, 1, 4) === 'PNG') return { kind: 'image', mime: 'image/png', ext: 'png' };
  if (ascii(b, 0, 4) === 'GIF8') return { kind: 'image', mime: 'image/gif', ext: 'gif' };
  if (ascii(b, 0, 4) === 'RIFF' && b.length >= 12) {
    if (ascii(b, 8, 12) === 'WEBP') return { kind: 'image', mime: 'image/webp', ext: 'webp' };
    if (ascii(b, 8, 12) === 'WAVE') return { kind: 'audio', mime: 'audio/wav', ext: 'wav' };
    return null;
  }
  // ISO base media (MP4, MOV, M4A, HEIC): a "ftyp" box at offset 4 with the major brand after it.
  if (b.length >= 12 && ascii(b, 4, 8) === 'ftyp') {
    const brand = ascii(b, 8, 12);
    if (['heic', 'heix', 'hevc', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) return { kind: 'image', mime: 'image/heic', ext: 'heic' };
    if (brand === 'avif' || brand === 'avis') return { kind: 'image', mime: 'image/avif', ext: 'avif' };
    if (brand === 'qt  ') return { kind: 'video', mime: 'video/quicktime', ext: 'mov' };
    if (brand === 'M4A ' || brand === 'M4B ' || declared?.startsWith('audio/')) return { kind: 'audio', mime: 'audio/mp4', ext: 'm4a' };
    return { kind: 'video', mime: 'video/mp4', ext: 'mp4' };
  }
  // Matroska / WebM: the container doesn't say whether there is video; the browser's MediaRecorder declares audio/webm.
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    return declared?.startsWith('audio/')
      ? { kind: 'audio', mime: 'audio/webm', ext: 'webm' }
      : { kind: 'video', mime: 'video/webm', ext: 'webm' };
  }
  if (ascii(b, 0, 4) === 'OggS') return { kind: 'audio', mime: 'audio/ogg', ext: 'ogg' };
  if (ascii(b, 0, 3) === 'ID3' || (b[0] === 0xff && (b[1]! & 0xe6) === 0xe2)) return { kind: 'audio', mime: 'audio/mpeg', ext: 'mp3' };
  if (b[0] === 0xff && (b[1]! & 0xf6) === 0xf0) return { kind: 'audio', mime: 'audio/aac', ext: 'aac' };
  return null;
}
