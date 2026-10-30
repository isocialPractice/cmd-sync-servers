import { Writable } from 'node:stream';

/** A writable that collects what a download writes. */
export function collector(): { stream: Writable; data: () => Buffer } {
  const chunks: Buffer[] = [];
  return {
    stream: new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk);
        callback();
      },
    }),
    data: () => Buffer.concat(chunks),
  };
}
