import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export interface TapeSessionClaims {
  sub: string;
  email: string;
  type: 'access' | 'refresh';
  iat: number;
  exp: number;
  jti: string;
  iss: 'tape-soundcloud-adapter';
}

export interface TapeTokenPair {
  access_token: string;
  refresh_token: string;
}

export class TapeTokenService {
  constructor(private readonly secret: string) {
    if (Buffer.byteLength(secret) < 32) throw new Error('TAPE_JWT_SECRET must contain at least 32 characters');
  }

  issuePair(email: string): TapeTokenPair {
    const now = Math.floor(Date.now() / 1000);
    return {
      access_token: this.sign({ sub: email, email, type: 'access', iat: now, exp: now + 60 * 60, jti: randomUUID(), iss: 'tape-soundcloud-adapter' }),
      refresh_token: this.sign({ sub: email, email, type: 'refresh', iat: now, exp: now + 30 * 24 * 60 * 60, jti: randomUUID(), iss: 'tape-soundcloud-adapter' }),
    };
  }

  verify(token: string, expectedType: TapeSessionClaims['type']): TapeSessionClaims | null {
    const pieces = token.split('.');
    if (pieces.length !== 3) return null;
    const [headerPart, payloadPart, signaturePart] = pieces;
    try {
      const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8')) as { alg?: string; typ?: string };
      if (header.alg !== 'HS256' || header.typ !== 'JWT') return null;
      const expected = Buffer.from(this.signature(`${headerPart}.${payloadPart}`), 'base64url');
      const actual = Buffer.from(signaturePart, 'base64url');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
      const claims = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as TapeSessionClaims;
      if (claims.iss !== 'tape-soundcloud-adapter' || claims.type !== expectedType || typeof claims.sub !== 'string' || typeof claims.email !== 'string' || typeof claims.jti !== 'string' || !Number.isFinite(claims.exp) || claims.exp <= Math.floor(Date.now() / 1000)) return null;
      return claims;
    } catch {
      return null;
    }
  }

  private sign(payload: TapeSessionClaims): string {
    const header = encode({ alg: 'HS256', typ: 'JWT' });
    const body = encode(payload);
    const message = `${header}.${body}`;
    return `${message}.${this.signature(message)}`;
  }

  private signature(message: string): string {
    return createHmac('sha256', this.secret).update(message).digest('base64url');
  }
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
