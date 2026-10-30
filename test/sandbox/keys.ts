// Throwaway SSH keys for tests. ssh2's generator now and then drops a leading
// zero byte from an ed25519 public key, which its own parser then rejects, so
// a key is regenerated until it parses.
import ssh2 from 'ssh2';

const { utils } = ssh2;

export function ed25519KeyPair(passphrase?: string): { private: string; public: string } {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const pair =
      passphrase === undefined
        ? utils.generateKeyPairSync('ed25519')
        : utils.generateKeyPairSync('ed25519', { passphrase, cipher: 'aes256-ctr', rounds: 16 });
    if (!(utils.parseKey(pair.private, passphrase) instanceof Error) && !(utils.parseKey(pair.public) instanceof Error)) {
      return pair;
    }
  }
  throw new Error('Could not generate a usable ed25519 key.');
}
