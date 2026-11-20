import {
  type AuthenticationResponseJSON, generateAuthenticationOptions, generateRegistrationOptions, type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON, type RegistrationResponseJSON, verifyAuthenticationResponse, verifyRegistrationResponse,
  type WebAuthnCredential,
} from '@simplewebauthn/server';
import { COSEALG } from '@simplewebauthn/server/helpers';
import type { Db } from '../../db/client.js';
import type { AuthSettings } from '../settings.js';
import { useRegistration } from './registrations.js';
import {
  type ChallengePurpose, consumeChallenge, findPasskey, insertPasskey, listPasskeys, type Passkey, recordPasskeyUse, saveChallenge,
  webauthnUserId,
} from './store.js';

const TIMEOUT_MS = 120_000;
/**
 * The key types every authenticator offers. Left to its default, the library also offers ML-DSA-44 when the runtime
 * has it, which in Node is an experimental Web Crypto API that prints a warning on first use.
 */
const ALGORITHMS = [COSEALG.EdDSA, COSEALG.ES256, COSEALG.RS256];
class Rollback extends Error {}

/**
 * The challenge check the library calls back. The library turns any error into a refused response, so a database
 * error is kept here and thrown again after it: a failing database is a server error, never a refused passkey.
 */
function challengeCheck(db: Db, purpose: ChallengePurpose, registrationId: string | null, now: Date) {
  let failure: { error: unknown } | undefined;
  return {
    consume: (challenge: string) =>
      consumeChallenge(db, challenge, purpose, registrationId, now).catch((error: unknown) => {
        failure = { error };
        return false;
      }),
    rethrow: () => {
      if (failure) throw failure.error;
    },
  };
}

/** Sign-in without a user name: any of the owner's passkeys (discoverable credentials), user verification required. */
export async function loginOptions(db: Db, auth: AuthSettings, now: Date): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const options = await generateAuthenticationOptions({ rpID: auth.rpId, userVerification: 'required', timeout: TIMEOUT_MS });
  await saveChallenge(db, { challenge: options.challenge, purpose: 'login', registrationId: null, now });
  return options;
}

/** The passkey that signed this sign-in, or null (unknown key, a challenge not issued or used, another origin, a counter that went back). */
export async function verifyLogin(db: Db, auth: AuthSettings, response: AuthenticationResponseJSON, now: Date): Promise<Passkey | null> {
  const passkey = await findPasskey(db, response.id);
  if (!passkey) return null;
  const challenges = challengeCheck(db, 'login', null, now);
  let newCounter: number;
  try {
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenges.consume,
      expectedOrigin: auth.issuer,
      expectedRPID: auth.rpId,
      requireUserVerification: true,
      credential: {
        id: passkey.credentialId,
        publicKey: new Uint8Array(Buffer.from(passkey.publicKey, 'base64url')),
        counter: passkey.counter,
        transports: passkey.transports,
      },
    });
    if (!result.verified) return null;
    newCounter = result.authenticationInfo.newCounter;
  } catch {
    challenges.rethrow();
    // The library explains why in its message (with the challenge in it); a refused sign-in needs no details.
    return null;
  }
  // Spec §4.1: a counter that did not move forward means a cloned authenticator. The library refuses it as well;
  // this check keeps the rule here whatever the library does.
  if (passkey.counter > 0 && newCounter <= passkey.counter) return null;
  await recordPasskeyUse(db, passkey.id, newCounter, now);
  return passkey;
}

/** A new resident passkey with user verification, attestation "none"; the owner's existing passkeys are excluded. */
export async function registrationOptions(db: Db, auth: AuthSettings, registrationId: string, now: Date): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const existing = await listPasskeys(db);
  const options = await generateRegistrationOptions({
    rpName: 'Tabula',
    rpID: auth.rpId,
    userName: 'tabula',
    userDisplayName: 'Tabula owner',
    userID: await webauthnUserId(db),
    attestationType: 'none',
    supportedAlgorithmIDs: ALGORITHMS,
    timeout: TIMEOUT_MS,
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    excludeCredentials: existing.map((p) => ({ id: p.credentialId, transports: p.transports })),
  });
  await saveChallenge(db, { challenge: options.challenge, purpose: 'register', registrationId, now });
  return options;
}

/** The new passkey, or null when the response does not verify or the registration permission was used meanwhile. */
export async function verifyRegistration(
  db: Db, auth: AuthSettings, input: { registrationId: string; response: RegistrationResponseJSON; name: string }, now: Date,
): Promise<Passkey | null> {
  const challenges = challengeCheck(db, 'register', input.registrationId, now);
  let credential: WebAuthnCredential;
  try {
    const result = await verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: challenges.consume,
      expectedOrigin: auth.issuer,
      expectedRPID: auth.rpId,
      requireUserVerification: true,
      supportedAlgorithmIDs: ALGORITHMS,
    });
    if (!result.verified) return null;
    credential = result.registrationInfo.credential;
  } catch {
    challenges.rethrow();
    return null;
  }
  try {
    return await db.transaction(async (tx) => {
      if (!(await useRegistration(tx, input.registrationId, now))) throw new Rollback();
      const passkey = await insertPasskey(tx, {
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString('base64url'),
        counter: credential.counter,
        transports: credential.transports ?? [],
        name: input.name,
        now,
      });
      if (!passkey) throw new Rollback();
      return passkey;
    });
  } catch (e) {
    if (e instanceof Rollback) return null;
    throw e;
  }
}
