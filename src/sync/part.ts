import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { Writable } from 'node:stream';
import { SyncError } from '../errors.ts';
import { baseName, childPath, parentPath, ROOT, toRemotePath, type RemotePath } from './paths.ts';

/** The partial copies a transfer writes before renaming them into place. */
const PART = /^\..*\.?sync-servers-[0-9a-f]{8}\.part$/;

/** True for the name of a partial copy, which scans skip: one left by a crash is never synchronized as a file. */
export function isPartName(name: string): boolean {
  return PART.test(name);
}

/** A sibling name for the partial copy, valid on every system. */
export function partName(target: RemotePath): string {
  const random = randomBytes(4).toString('hex');
  const name = `.${baseName(target)}.sync-servers-${random}.part`;
  return Buffer.byteLength(name, 'utf8') <= 255 ? name : `.sync-servers-${random}.part`;
}

/** The site-relative path of a partial copy beside `target`. */
export function partPath(target: RemotePath): RemotePath {
  const parent = parentPath(target) ?? ROOT;
  const checked = childPath(parent, partName(target));
  return checked.ok ? checked.path : toRemotePath(`${parent === ROOT ? '' : `${parent}/`}.sync-servers-${randomBytes(4).toString('hex')}.part`);
}

/**
 * A file to download into that fails as soon as more than `maxBytes` arrive,
 * so a server cannot fill the disk by sending more than it listed. It
 * finishes only once the file is written. Private to the user (`0600`).
 */
export function cappedFile(file: string, options: { readonly flags: string; readonly maxBytes: number; readonly what: string }): Writable {
  const out = createWriteStream(file, { flags: options.flags, mode: 0o600 });
  let written = 0;
  const writer = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      written += chunk.length;
      if (written > options.maxBytes) {
        callback(new SyncError('E_REMOTE', `${options.what}: the server sent more than the ${String(options.maxBytes)} bytes it listed.`));
        return;
      }
      if (out.write(chunk)) {
        callback();
      } else {
        out.once('drain', () => {
          callback();
        });
      }
    },
    final(callback) {
      out.end();
      out.once('finish', () => {
        callback();
      });
    },
    destroy(error, callback) {
      out.destroy();
      callback(error);
    },
  });
  out.on('error', (error) => {
    writer.destroy(error);
  });
  return writer;
}
