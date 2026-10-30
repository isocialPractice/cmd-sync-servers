import type { SecretRef, SecretRequest, SecretSource } from './types.ts';

/** Asks a person for a secret; resolves `undefined` when they cancel. */
export type SecretPrompt = (request: SecretRequest) => Promise<string | undefined>;

/** Asks for a secret each time one is needed. `describe` supplies the context shown with the question. */
export class PromptSecretSource implements SecretSource {
  readonly #prompt: SecretPrompt;
  readonly #describe: (ref: SecretRef) => SecretRequest;

  constructor(prompt: SecretPrompt, describe: (ref: SecretRef) => SecretRequest) {
    this.#prompt = prompt;
    this.#describe = describe;
  }

  /** Asks for the secret of `ref`; `undefined` when the person cancels. */
  get(ref: SecretRef): Promise<string | undefined> {
    return this.#prompt(this.#describe(ref));
  }
}

/**
 * The question shown when asking for a secret, such as
 * `Password for demo-user on sftp.example.com (My Site: Production): `, or
 * `Password for sftp.example.com (My Site: Production): ` without a user.
 */
export function secretQuestion(request: SecretRequest): string {
  const what = request.ref.kind === 'password' ? 'Password' : 'Key passphrase';
  const account = request.host === undefined ? '' : ` for ${request.username === undefined ? '' : `${request.username} on `}${request.host}`;
  return `${what}${account} (${request.siteName}: ${request.serverName}): `;
}
