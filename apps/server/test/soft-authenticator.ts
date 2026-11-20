import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from 'node:crypto';
import type {
  AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { isoCBOR } from '@simplewebauthn/server/helpers';

type Cbor = Parameters<typeof isoCBOR.encode>[0];
const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest();

/** A WebAuthn authenticator in software for the server tests: P-256 (ES256), attestation "none", user verified unless `uv: false`. */
export class SoftAuthenticator {
  readonly credentialId = randomBytes(16);
  private readonly keys: { privateKey: KeyObject; publicKey: KeyObject } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  counter = 0;
  private userHandle: string | undefined;

  constructor(readonly origin: string, readonly rpId = new URL(origin).hostname) {}

  private authData(flags: number, attested?: Buffer): Buffer {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(this.counter);
    return Buffer.concat([sha256(this.rpId), Buffer.from([flags]), count, ...(attested ? [attested] : [])]);
  }

  private coseKey(): Buffer {
    const jwk = this.keys.publicKey.export({ format: 'jwk' });
    const key = new Map<number, number | Uint8Array>([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, Buffer.from(jwk.x!, 'base64url')],
      [-3, Buffer.from(jwk.y!, 'base64url')],
    ]);
    return Buffer.from(isoCBOR.encode(key as unknown as Cbor));
  }

  private clientData(type: 'webauthn.create' | 'webauthn.get', challenge: string, origin: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  register(options: PublicKeyCredentialCreationOptionsJSON, opts: { origin?: string; uv?: boolean } = {}): RegistrationResponseJSON {
    this.userHandle = options.user.id;
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.credentialId.length);
    const attested = Buffer.concat([Buffer.alloc(16), idLength, this.credentialId, this.coseKey()]);
    // Flags: user present (0x01), user verified (0x04), attested credential data (0x40).
    const authData = this.authData(opts.uv === false ? 0x41 : 0x45, attested);
    const attestation = new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]);
    return {
      id: b64u(this.credentialId),
      rawId: b64u(this.credentialId),
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(this.clientData('webauthn.create', options.challenge, opts.origin ?? this.origin)),
        attestationObject: b64u(isoCBOR.encode(attestation as unknown as Cbor)),
        transports: ['internal'],
      },
    };
  }

  login(options: PublicKeyCredentialRequestOptionsJSON, opts: { origin?: string; counter?: number; uv?: boolean } = {}): AuthenticationResponseJSON {
    this.counter = opts.counter ?? this.counter + 1;
    const authData = this.authData(opts.uv === false ? 0x01 : 0x05);
    const clientData = this.clientData('webauthn.get', options.challenge, opts.origin ?? this.origin);
    const signature = sign('sha256', Buffer.concat([authData, sha256(clientData)]), this.keys.privateKey);
    return {
      id: b64u(this.credentialId),
      rawId: b64u(this.credentialId),
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(clientData),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
        ...(this.userHandle ? { userHandle: this.userHandle } : {}),
      },
    };
  }
}
