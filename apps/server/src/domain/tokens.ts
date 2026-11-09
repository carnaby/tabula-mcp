export const DIGEST_BUDGET = 3000;

/** Rough estimate per the spec: characters / 4. Imprecise for Slovak; to be calibrated after the first week. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

export const wordCount = (text: string): number => {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
};
