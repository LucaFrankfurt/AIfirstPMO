/**
 * The S3 client, as a place `kernel/files/storage.ts` can put bytes.
 *
 * `storage.ts` used to import this adapter and branch on `kind === 's3'` in six
 * functions, which meant the kernel knew one specific provider by name. It
 * offers a `Backend` interface now and this fills it in; the only thing left
 * naming S3 in the kernel is the configuration value, which is what
 * configuration is for.
 */
import { Readable } from 'node:stream';
import { env } from '../../kernel/platform/env.ts';
import { registerBackend, type Backend } from '../../kernel/files/storage.ts';
import * as s3 from './s3.ts';

const backend: Backend = {
  init: () => s3.ensureBucket(env.storage.s3),
  put: (key, body, mime) => s3.putObject(env.storage.s3, key, body, mime),
  exists: async (key) => (await s3.headObject(env.storage.s3, key)) !== null,
  async read(key) {
    const response = await s3.getObject(env.storage.s3, key);
    if (!response.body) return null;
    return {
      stream: Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      size: Number(response.headers.get('content-length') ?? 0) || undefined,
    };
  },
  remove: (key) => s3.deleteObject(env.storage.s3, key),
  directUrl(key, filename, mime) {
    if (!env.storage.presign) return null;
    // Sign for the host the browser will actually connect to.
    const config = env.storage.publicEndpoint
      ? { ...env.storage.s3, endpoint: env.storage.publicEndpoint }
      : env.storage.s3;
    return s3.presignGet(config, key, env.storage.presignSeconds, new Date(), filename, mime);
  },
  describe: () =>
    `s3 (${env.storage.s3.endpoint}/${env.storage.s3.bucket}${env.storage.presign ? ', pre-signed URLs' : ''})`,
};

/** Hung off storage by `wiring.ts`. */
export const installS3Storage = (): void => registerBackend('s3', backend);
