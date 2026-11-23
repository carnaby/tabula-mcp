/**
 * The type of an uploaded file is never taken from its file name or from the client's word alone: Tabula serves
 * attachments from its own origin, so an HTML or SVG file posing as an image could read the token from the page.
 * Media (photos, videos, audio) are recognised from their first bytes; documents (below) by their declared
 * Content-Type, checked against the first bytes. Only the formats below are accepted.
 */
export type MediaKind = 'image' | 'video' | 'audio' | 'document';
export type Sniffed = { kind: MediaKind; mime: string; ext: string };

/** How many leading bytes sniff() needs. */
export const SNIFF_BYTES = 64;

const ascii = (b: Buffer, start: number, end: number) => b.subarray(start, end).toString('latin1');

type DocumentType = { mime: string; ext: string; signature: 'pdf' | 'zip' | 'text' };

const MARKDOWN: DocumentType = { mime: 'text/markdown; charset=utf-8', ext: 'md', signature: 'text' };

/**
 * Documents (App API spec §3.1). Here the declared Content-Type names the type and the first bytes must agree: a PDF
 * starts with "%PDF-", OOXML and ODF files are ZIP archives, and text must be UTF-8 without NUL (MediaStore.receive
 * checks every byte). They are only ever downloaded, never shown in a page. HTML, SVG and executables are not among them.
 */
const DOCUMENTS = new Map<string, DocumentType>([
  ['application/pdf', { mime: 'application/pdf', ext: 'pdf', signature: 'pdf' }],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx', signature: 'zip' }],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx', signature: 'zip' }],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: 'pptx', signature: 'zip' }],
  ['application/vnd.oasis.opendocument.text', { mime: 'application/vnd.oasis.opendocument.text', ext: 'odt', signature: 'zip' }],
  ['text/plain', { mime: 'text/plain; charset=utf-8', ext: 'txt', signature: 'text' }],
  ['text/markdown', MARKDOWN],
  // Some systems name Markdown this way.
  ['text/x-markdown', MARKDOWN],
]);

/** The document type a Content-Type declares (parameters such as charset ignored, any letter case), or undefined. */
export const declaredDocument = (declared?: string): DocumentType | undefined =>
  DOCUMENTS.get((declared ?? '').split(';')[0]!.trim().toLowerCase());

function hasSignature(b: Buffer, signature: DocumentType['signature']): boolean {
  if (signature === 'pdf') return ascii(b, 0, 5) === '%PDF-';
  if (signature === 'zip') return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
  return b.length > 0 && !b.includes(0);
}

export function sniff(head: Buffer, declared?: string): Sniffed | null {
  const doc = declaredDocument(declared);
  // A declared document is that document or nothing: its bytes never make it a photo or a recording.
  if (doc) return hasSignature(head, doc.signature) ? { kind: 'document', mime: doc.mime, ext: doc.ext } : null;
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
