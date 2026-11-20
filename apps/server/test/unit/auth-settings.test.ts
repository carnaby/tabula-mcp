import { describe, expect, it } from 'vitest';
import { authSettings, resourceKindOf } from '../../src/auth/settings.js';

describe('authSettings', () => {
  it('is null without a public URL', () => {
    expect(authSettings({ publicUrl: undefined })).toBeNull();
  });

  it('derives the issuer, both resources, the RP ID and a __Host- cookie for https', () => {
    expect(authSettings({ publicUrl: 'https://tabula.example.com' })).toEqual({
      issuer: 'https://tabula.example.com',
      resources: { mcp: 'https://tabula.example.com/mcp', api: 'https://tabula.example.com/api' },
      rpId: 'tabula.example.com',
      cookie: { name: '__Host-tabula_session', secure: true },
    });
  });

  it('uses a plain cookie on http://localhost, where __Host- would be dropped', () => {
    expect(authSettings({ publicUrl: 'http://localhost:3100' })!.cookie).toEqual({ name: 'tabula_session', secure: false });
    expect(authSettings({ publicUrl: 'http://localhost:3100' })!.rpId).toBe('localhost');
  });

  it('maps a resource URL to its kind', () => {
    const auth = authSettings({ publicUrl: 'https://tabula.example.com' })!;
    expect(resourceKindOf(auth, 'https://tabula.example.com/mcp')).toBe('mcp');
    expect(resourceKindOf(auth, 'https://tabula.example.com/api')).toBe('api');
    expect(resourceKindOf(auth, 'https://tabula.example.com/mcp/')).toBeNull();
    expect(resourceKindOf(auth, 'https://other.example.com/mcp')).toBeNull();
  });
});
