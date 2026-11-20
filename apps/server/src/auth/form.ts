import type { FastifyInstance, FastifyRequest } from 'fastify';

const FORM = 'application/x-www-form-urlencoded';

/**
 * A parsed application/x-www-form-urlencoded body: each parameter once, and whether any came twice (RFC 6749 §3.2
 * forbids that; `code=a&code=b` must not pass as `b`). A class, so a JSON body that looks like a form is not one.
 */
export class FormBody {
  constructor(private readonly values: Map<string, string>, readonly repeated: boolean) {}

  get(name: string): string | undefined {
    return this.values.get(name);
  }
}

export const formOf = (req: FastifyRequest): FormBody | undefined => (req.body instanceof FormBody ? req.body : undefined);

/** Adds the form parser inside `instance` only (an encapsulated context): the rest of the app keeps accepting JSON alone. */
export function useFormBody(instance: FastifyInstance): void {
  instance.addContentTypeParser(FORM, { parseAs: 'string' }, (_req, body, done) => {
    const values = new Map<string, string>();
    let repeated = false;
    for (const [key, value] of new URLSearchParams(body as string)) {
      if (values.has(key)) repeated = true;
      values.set(key, value);
    }
    done(null, new FormBody(values, repeated));
  });
}
