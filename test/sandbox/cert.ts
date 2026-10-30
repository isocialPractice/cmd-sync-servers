// Generates a throwaway self-signed X.509 certificate in memory for the FTPS
// sandbox, with no openssl needed. Never written into the repository.
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';

export interface TestCertificate {
  /** PEM certificate, also usable as its own CA for `tls.caFile`. */
  readonly cert: string;
  /** PEM PKCS#8 private key. */
  readonly key: string;
}

export interface CertificateOptions {
  readonly commonName?: string;
  readonly dnsNames?: readonly string[];
  readonly ipAddresses?: readonly string[];
  readonly keyType?: 'ec' | 'rsa';
  readonly days?: number;
}

function derLength(length: number): Buffer {
  if (length < 0x80) {
    return Buffer.from([length]);
  }
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) {
    bytes.unshift(rest % 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(value.length), value]);
}

const sequence = (...items: Buffer[]): Buffer => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]): Buffer => tlv(0x31, Buffer.concat(items));
const explicit = (tag: number, value: Buffer): Buffer => tlv(0xa0 + tag, value);
const octetString = (value: Buffer): Buffer => tlv(0x04, value);
const bitString = (value: Buffer): Buffer => tlv(0x03, Buffer.concat([Buffer.from([0]), value]));
const boolean = (value: boolean): Buffer => tlv(0x01, Buffer.from([value ? 0xff : 0]));
const utf8String = (text: string): Buffer => tlv(0x0c, Buffer.from(text, 'utf8'));
const NULL = Buffer.from([0x05, 0x00]);

function integer(value: Buffer): Buffer {
  let bytes = value;
  while (bytes.length > 1 && bytes[0] === 0 && ((bytes[1] ?? 0) & 0x80) === 0) {
    bytes = bytes.subarray(1);
  }
  if (((bytes[0] ?? 0) & 0x80) !== 0) {
    bytes = Buffer.concat([Buffer.from([0]), bytes]);
  }
  return tlv(0x02, bytes);
}

function objectId(dotted: string): Buffer {
  const [first = 0, second = 0, ...rest] = dotted.split('.').map(Number);
  const bytes = [40 * first + second];
  for (const part of rest) {
    const encoded = [part % 128];
    for (let value = Math.floor(part / 128); value > 0; value = Math.floor(value / 128)) {
      encoded.unshift((value % 128) | 0x80);
    }
    bytes.push(...encoded);
  }
  return tlv(0x06, Buffer.from(bytes));
}

function utcTime(date: Date): Buffer {
  const iso = date.toISOString();
  const text = `${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
  return tlv(0x17, Buffer.from(text, 'ascii'));
}

function pem(label: string, der: Buffer): string {
  const lines = der.toString('base64').match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

/** A self-signed certificate for `localhost` and `127.0.0.1` by default, valid from a minute ago. */
export function selfSignedCertificate(options: CertificateOptions = {}): TestCertificate {
  const keyType = options.keyType ?? 'ec';
  const { publicKey, privateKey } =
    keyType === 'ec' ? generateKeyPairSync('ec', { namedCurve: 'prime256v1' }) : generateKeyPairSync('rsa', { modulusLength: 2048 });
  const signatureAlgorithm = keyType === 'ec' ? sequence(objectId('1.2.840.10045.4.3.2')) : sequence(objectId('1.2.840.113549.1.1.11'), NULL);
  const name = sequence(set(sequence(objectId('2.5.4.3'), utf8String(options.commonName ?? 'localhost'))));
  const now = Date.now();
  const validity = sequence(utcTime(new Date(now - 60_000)), utcTime(new Date(now + (options.days ?? 2) * 86_400_000)));
  const alternativeNames = sequence(
    ...(options.dnsNames ?? ['localhost']).map((dns) => tlv(0x82, Buffer.from(dns, 'ascii'))),
    ...(options.ipAddresses ?? ['127.0.0.1']).map((ip) => tlv(0x87, Buffer.from(ip.split('.').map(Number)))),
  );
  const extensions = explicit(
    3,
    sequence(
      sequence(objectId('2.5.29.19'), boolean(true), octetString(sequence(boolean(true)))),
      sequence(objectId('2.5.29.17'), octetString(alternativeNames)),
    ),
  );
  const toBeSigned = sequence(
    explicit(0, integer(Buffer.from([2]))),
    integer(randomBytes(16)),
    signatureAlgorithm,
    name,
    validity,
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    extensions,
  );
  const signature = sign('sha256', toBeSigned, privateKey);
  return {
    cert: pem('CERTIFICATE', sequence(toBeSigned, signatureAlgorithm, bitString(signature))),
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}
