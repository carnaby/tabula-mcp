import { createHash, randomBytes } from 'node:crypto';

/** Every secret Tabula mints (tokens, codes, cookies, links): 32 CSPRNG bytes in base64url, handed out once. */
export const newSecret = (): string => randomBytes(32).toString('base64url');

/** What the database keeps instead of a secret. 256 random bits need no salt or slow hash. */
export const hashSecret = (value: string): string => createHash('sha256').update(value).digest('hex');
