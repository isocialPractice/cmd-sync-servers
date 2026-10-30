import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
import { checkServerIdentity, type PeerCertificate } from 'node:tls';
import type { CertificateDecision, CertificateInfo, CertificateProblem } from '../host.ts';
import { safeLine } from '../terminal-text.ts';

/**
 * Looks host names and addresses up, for suggesting a name a certificate
 * covers. Injectable so tests need no real DNS.
 *
 * @experimental
 */
export interface NameResolver {
  /** The addresses a host name resolves to. */
  lookup(host: string): Promise<readonly string[]>;
  /** The names an address resolves back to. */
  reverse(address: string): Promise<readonly string[]>;
}

/** The system resolver. */
export const systemResolver: NameResolver = {
  lookup: async (host) => (await dns.lookup(host, { all: true })).map((entry) => entry.address),
  reverse: (address) => dns.reverse(address),
};

/** A certificate a person chose to trust, as kept in a server's `options.tls.trustedCertificate`. */
export interface TrustedCertificate {
  /** Colon-separated upper-case hex. */
  readonly sha256: string;
  /** ISO 8601. */
  readonly validTo: string;
  /** ISO 8601. */
  readonly pinnedAt: string;
}

/**
 * What a certificate decision changes on the server: the host, the name the
 * certificate is checked as, or the trusted certificate.
 *
 * @experimental
 */
export type CertificateChange = { readonly host: string } | { readonly servername: string } | { readonly trustedCertificate: TrustedCertificate };

/** How long all lookups for one suggestion may take together. */
const LOOKUP_BUDGET_MS = 2000;

/**
 * `3A:91:...`, the form Node and most clients show, from a fingerprint
 * written with or without colons, in any case, optionally after `SHA256:`.
 * `undefined` when it is not a SHA-256 fingerprint.
 *
 * @experimental
 */
export function normalizeCertificateFingerprint(text: string): string | undefined {
  const hex = text.trim().replace(/^SHA-?256:?/i, '').replace(/[:\s]/g, '').toUpperCase();
  return /^[0-9A-F]{64}$/.test(hex) ? (hex.match(/../g) ?? []).join(':') : undefined;
}

function field(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(', ') : value;
}

/** DNS and IP names of the subject alternative names, or the subject CN when there are none. */
export function certificateNames(cert: PeerCertificate): string[] {
  const names: string[] = [];
  const pattern = /(DNS|IP Address):("(?:[^"\\]|\\.)*"|[^,]*)/g;
  for (const match of (cert.subjectaltname ?? '').matchAll(pattern)) {
    const raw = (match[2] ?? '').trim();
    let value = raw;
    if (raw.startsWith('"')) {
      try {
        value = JSON.parse(raw) as string;
      } catch {
        value = raw;
      }
    }
    if (value !== '') {
      names.push(value);
    }
  }
  const common = field(cert.subject.CN);
  return names.length === 0 && common !== undefined ? [common] : names;
}

function issuerName(cert: PeerCertificate): string {
  const issuer = cert.issuer;
  return field(issuer.CN) ?? field(issuer.O) ?? (Object.values(issuer).map((value) => field(value as string | string[])).join(', ') || 'unknown');
}

function isoDate(text: string | undefined): string {
  const time = text === undefined ? Number.NaN : Date.parse(text);
  return Number.isNaN(time) ? '' : new Date(time).toISOString();
}

/**
 * Why a certificate did not verify, from Node's authorization error and the
 * certificate's dates: dates are checked first, because a chain error hides
 * every other problem.
 */
export function certificateProblem(code: string | Error | null | undefined, cert: PeerCertificate, now: number): CertificateProblem {
  const from = Date.parse(cert.valid_from);
  const to = Date.parse(cert.valid_to);
  if (!Number.isNaN(to) && now > to) {
    return 'expired';
  }
  if (!Number.isNaN(from) && now < from) {
    return 'not-yet-valid';
  }
  const text = typeof code === 'string' ? code : (code?.message ?? '');
  if (/ALTNAME|HOSTNAME|IP_ADDRESS_MISMATCH/i.test(text)) {
    return 'name-mismatch';
  }
  if (/DEPTH_ZERO_SELF_SIGNED/i.test(text)) {
    return 'self-signed';
  }
  if (/SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_GET_ISSUER|UNABLE_TO_VERIFY_LEAF|CERT_UNTRUSTED|INVALID_CA|CERT_SIGNATURE_FAILURE/i.test(text)) {
    return 'untrusted-issuer';
  }
  if (/EXPIRED/i.test(text)) {
    return 'expired';
  }
  if (/NOT_YET_VALID/i.test(text)) {
    return 'not-yet-valid';
  }
  return 'other';
}

/** A {@link CertificateInfo} from a peer certificate; every string from the certificate is escaped. */
export function describeCertificate(
  cert: PeerCertificate,
  host: string,
  port: number,
  problem: CertificateProblem,
  extra: Pick<CertificateInfo, 'coveredNames' | 'previousSha256'> = { coveredNames: [] },
): CertificateInfo {
  return {
    host,
    port,
    names: certificateNames(cert).map(safeLine),
    issuer: safeLine(issuerName(cert)),
    validFrom: isoDate(cert.valid_from),
    validTo: isoDate(cert.valid_to),
    sha256: cert.fingerprint256,
    problem,
    coveredNames: extra.coveredNames,
    ...(extra.previousSha256 === undefined ? {} : { previousSha256: extra.previousSha256 }),
  };
}

function withBudget<T>(promise: Promise<T>, deadline: number, fallback: T): Promise<T> {
  const left = deadline - Date.now();
  if (left <= 0) {
    return Promise.resolve(fallback);
  }
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise.catch(() => fallback),
    new Promise<T>((resolve) => {
      timer = setTimeout(() => {
        resolve(fallback);
      }, left);
    }),
  ]).finally(() => {
    clearTimeout(timer);
  });
}

/**
 * Host names that the certificate covers and that resolve to the same
 * machine as `host`: the reverse lookup of the host's addresses, then the
 * certificate's own names without wildcards. A candidate is kept only when
 * the certificate verifies for it and its forward lookup includes one of the
 * host's addresses. Lookups take at most two seconds together and fail
 * quietly to no suggestion.
 *
 * @experimental
 */
export async function findCoveredNames(
  host: string,
  cert: PeerCertificate,
  resolver: NameResolver = systemResolver,
  connectedAddress?: string,
): Promise<string[]> {
  const deadline = Date.now() + LOOKUP_BUDGET_MS;
  const addresses = new Set<string>(isIP(host) === 0 ? await withBudget(resolver.lookup(host), deadline, []) : [host]);
  if (connectedAddress !== undefined && isIP(connectedAddress) !== 0) {
    addresses.add(connectedAddress.replace(/^::ffff:/, ''));
  }
  if (addresses.size === 0) {
    return [];
  }
  const candidates: string[] = [];
  for (const address of addresses) {
    for (const name of await withBudget(resolver.reverse(address), deadline, [])) {
      candidates.push(name.replace(/\.$/, ''));
    }
  }
  for (const name of certificateNames(cert)) {
    if (!name.includes('*') && isIP(name) === 0) {
      candidates.push(name);
    }
  }
  const covered: string[] = [];
  const seen = new Set<string>([host.toLowerCase()]);
  for (const candidate of candidates) {
    const key = candidate.toLowerCase();
    if (seen.has(key) || isIP(candidate) !== 0 || checkServerIdentity(candidate, cert) !== undefined) {
      continue;
    }
    seen.add(key);
    const forward = await withBudget(resolver.lookup(candidate), deadline, []);
    if (forward.some((address) => addresses.has(address))) {
      covered.push(candidate);
    }
  }
  return covered;
}

function describeProblem(info: CertificateInfo): string {
  const where = `${info.host}:${String(info.port)}`;
  switch (info.problem) {
    case 'name-mismatch':
      return `The certificate of ${where} does not name ${info.host}.`;
    case 'self-signed':
      return `The certificate of ${where} is signed by itself, not by a certificate authority this computer trusts.`;
    case 'untrusted-issuer':
      return `The certificate of ${where} was issued by an authority this computer does not trust.`;
    case 'expired':
      return `The certificate of ${where} expired on ${info.validTo.slice(0, 10)}.`;
    case 'not-yet-valid':
      return `The certificate of ${where} is not valid until ${info.validFrom.slice(0, 10)}.`;
    case 'changed':
      return `The certificate of ${where} is not the one trusted for this server before.`;
    case 'other':
      return `The certificate of ${where} could not be verified.`;
  }
}

/** The lines that show a certificate to a person: names, issuer, validity and fingerprints. */
export function certificateLines(info: CertificateInfo): string[] {
  return [
    `  Issued to  ${info.names.join(', ') || 'no names'}`,
    `  Issued by  ${info.issuer}`,
    `  Valid      ${info.validFrom.slice(0, 10)} to ${info.validTo.slice(0, 10)}`,
    ...(info.previousSha256 === undefined ? [`  SHA-256    ${info.sha256}`] : [`  Trusted    ${info.previousSha256}`, `  Offered    ${info.sha256}`]),
  ];
}

/** The first lines shown about a certificate problem: what is wrong, then the certificate. */
export function certificateSummary(info: CertificateInfo): string {
  return [describeProblem(info), ...certificateLines(info)].join('\n');
}

/** What a person is asked about a certificate: the question, the choices best first, and the one Enter takes. */
export interface CertificateQuestion {
  readonly question: string;
  readonly choices: readonly { readonly label: string; readonly value: CertificateDecision }[];
  readonly initial: number;
}

/**
 * The choices for a certificate that did not verify: a host name it covers
 * first, then checking it as that name, then trusting it, then cancel. Only
 * trusting and cancel are offered when no covered name was found, and then
 * cancel is the default.
 */
export function certificateQuestion(info: CertificateInfo): CertificateQuestion {
  const covered = info.coveredNames[0];
  const trust = info.problem === 'changed' ? `Trust the new certificate for ${info.host}` : `Trust this certificate for ${info.host}`;
  if (covered !== undefined) {
    return {
      question: `${info.host} is ${covered}, which this certificate covers.`,
      choices: [
        { label: `Connect to ${covered} instead (recommended)`, value: { action: 'use-host', host: covered } },
        { label: `Keep ${info.host} and check the certificate as ${covered}`, value: { action: 'check-as', servername: covered } },
        { label: trust, value: { action: 'accept-and-pin' } },
        { label: 'Cancel', value: { action: 'reject' } },
      ],
      initial: 0,
    };
  }
  return {
    question:
      info.problem === 'changed'
        ? 'A new certificate can be a renewal, or a machine in the middle. Check the new fingerprint with the host before you trust it.'
        : 'Check this fingerprint with the host before you trust it.',
    choices: [
      { label: trust, value: { action: 'accept-and-pin' } },
      { label: 'Cancel', value: { action: 'reject' } },
    ],
    initial: 1,
  };
}

/**
 * The message of an `E_TLS_CERT` error nobody could decide on: what is
 * wrong, the certificate, and the fixes. Expired and not-yet-valid
 * certificates are never trusted, so they get no trust fix.
 */
export function certificateMessage(info: CertificateInfo, serverName: string | undefined): string {
  const server = serverName === undefined ? '<server>' : /^[\w.-]+$/.test(serverName) ? serverName : JSON.stringify(serverName);
  if (info.problem === 'expired' || info.problem === 'not-yet-valid') {
    return [
      certificateSummary(info),
      'A certificate outside its validity dates is never trusted. Ask the host to renew it, or check the date and time of this computer.',
    ].join('\n');
  }
  const covered = info.coveredNames[0];
  return [
    certificateSummary(info),
    ...(covered === undefined
      ? [`Connect to a host name the certificate lists, or run "sync-servers server test" in a terminal to decide, or pass --trust-certificate ${info.sha256} after checking it with the host.`]
      : [
          `Connect to a host it covers:  sync-servers server edit ${server} --host ${covered}`,
          `Or run "sync-servers server test" in a terminal to decide, or pass --trust-certificate ${info.sha256} after checking it with the host.`,
        ]),
  ].join('\n');
}
