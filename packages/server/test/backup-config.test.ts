/**
 * Where a backup bucket's settings come from when nobody typed them.
 *
 * The whole point of a bucket being "simple" is that on an instance whose
 * uploads are already in S3, its name is the only thing to fill in — and the
 * whole danger is the same rule applied where it does not belong: keys
 * borrowed for an endpoint they were never issued for, or a region guessed
 * over one somebody typed. So both halves are pinned here, against the
 * environment alone, with the uploads in a bucket (the case that borrows).
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-backup-config-${process.pid}`;
process.env.KOLIBRI_STORAGE = 's3';
process.env.KOLIBRI_S3_ENDPOINT = 'http://minio:9000';
process.env.KOLIBRI_S3_BUCKET = 'kolibri';
process.env.KOLIBRI_S3_REGION = 'eu-west-9';
process.env.KOLIBRI_S3_ACCESS_KEY = 'storage-key';
process.env.KOLIBRI_S3_SECRET_KEY = 'storage-secret';

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, afterEach, describe, it } from 'node:test';

const { env, refreshEnv, regionOf } = await import('../src/kernel/platform/env.ts');

const BACKUP = [
  'KOLIBRI_BACKUP_S3_BUCKET', 'KOLIBRI_BACKUP_S3_ENDPOINT', 'KOLIBRI_BACKUP_S3_REGION',
  'KOLIBRI_BACKUP_S3_ACCESS_KEY', 'KOLIBRI_BACKUP_S3_SECRET_KEY', 'KOLIBRI_BACKUP_S3_PATH_STYLE',
  'KOLIBRI_BACKUP_OFFSITE', 'KOLIBRI_BACKUP_EMAIL_MAX_MB',
];

/** Set exactly these and re-read, the way saving the settings screen does. */
function given(values: Record<string, string>): void {
  for (const name of BACKUP) delete process.env[name];
  Object.assign(process.env, values);
  refreshEnv();
}

afterEach(() => given({}));
after(() => rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true }));

describe('a bucket for backups on an instance whose uploads are in S3', () => {
  it('needs only a name: the endpoint and keys are the uploads’', () => {
    given({ KOLIBRI_BACKUP_S3_BUCKET: 'kolibri-backups' });
    assert.deepEqual(
      { ...env.backup.s3 },
      {
        endpoint: 'http://minio:9000',
        bucket: 'kolibri-backups',
        region: 'eu-west-9',
        accessKeyId: 'storage-key',
        secretAccessKey: 'storage-secret',
        forcePathStyle: true,
        borrowed: true,
        shared: false,
        unreadable: false,
      },
    );
  });

  it('takes a key of its own where one is typed, on the same store', () => {
    // A key allowed to write backups and nothing else is the careful setup.
    given({ KOLIBRI_BACKUP_S3_BUCKET: 'kolibri-backups', KOLIBRI_BACKUP_S3_ACCESS_KEY: 'backup-only', KOLIBRI_BACKUP_S3_SECRET_KEY: 's' });
    assert.equal(env.backup.s3.endpoint, 'http://minio:9000');
    assert.equal(env.backup.s3.accessKeyId, 'backup-only');
    assert.equal(env.backup.s3.secretAccessKey, 's');
  });

  it('borrows nothing for an endpoint of its own, whose keys are somebody else’s', () => {
    given({ KOLIBRI_BACKUP_S3_BUCKET: 'offsite', KOLIBRI_BACKUP_S3_ENDPOINT: 'https://s3.fr-par.scw.cloud/' });
    assert.equal(env.backup.s3.endpoint, 'https://s3.fr-par.scw.cloud', 'a trailing slash is not part of an endpoint');
    assert.equal(env.backup.s3.accessKeyId, '');
    assert.equal(env.backup.s3.secretAccessKey, '');
    assert.equal(env.backup.s3.region, 'fr-par', 'read off the host rather than borrowed');
    assert.equal(env.backup.s3.borrowed, false);
  });

  it('reads the older switch as the uploads’ own bucket, and knows the blobs are already there', () => {
    given({ KOLIBRI_BACKUP_OFFSITE: 'true' });
    assert.equal(env.backup.s3.bucket, 'kolibri');
    assert.equal(env.backup.s3.shared, true);
    // A bucket of its own wins over the older spelling.
    given({ KOLIBRI_BACKUP_OFFSITE: 'true', KOLIBRI_BACKUP_S3_BUCKET: 'kolibri-backups' });
    assert.equal(env.backup.s3.bucket, 'kolibri-backups');
    assert.equal(env.backup.s3.shared, false);
  });

  it('addresses AWS by subdomain and everybody else by path, unless told', () => {
    given({ KOLIBRI_BACKUP_S3_BUCKET: 'b', KOLIBRI_BACKUP_S3_ENDPOINT: 'https://s3.eu-central-1.amazonaws.com' });
    assert.equal(env.backup.s3.forcePathStyle, false);
    given({ KOLIBRI_BACKUP_S3_BUCKET: 'b', KOLIBRI_BACKUP_S3_ENDPOINT: 'https://s3.eu-central-003.backblazeb2.com' });
    assert.equal(env.backup.s3.forcePathStyle, true);
    // Compose writes an empty string for an unset variable; that is "work it out", not "no".
    given({ KOLIBRI_BACKUP_S3_BUCKET: 'b', KOLIBRI_BACKUP_S3_ENDPOINT: 'https://s3.fr-par.scw.cloud', KOLIBRI_BACKUP_S3_PATH_STYLE: '' });
    assert.equal(env.backup.s3.forcePathStyle, true);
    given({ KOLIBRI_BACKUP_S3_BUCKET: 'b', KOLIBRI_BACKUP_S3_ENDPOINT: 'https://s3.fr-par.scw.cloud', KOLIBRI_BACKUP_S3_PATH_STYLE: 'false' });
    assert.equal(env.backup.s3.forcePathStyle, false);
  });

  it('lets a typed region win over the one in the host', () => {
    given({ KOLIBRI_BACKUP_S3_BUCKET: 'b', KOLIBRI_BACKUP_S3_ENDPOINT: 'https://s3.fr-par.scw.cloud', KOLIBRI_BACKUP_S3_REGION: 'nl-ams' });
    assert.equal(env.backup.s3.region, 'nl-ams');
  });
});

describe('the region an endpoint names', () => {
  it('is read off the providers that spell it into the host', () => {
    const cases: [string, string][] = [
      ['https://s3.fr-par.scw.cloud', 'fr-par'],
      ['https://s3.eu-central-1.amazonaws.com', 'eu-central-1'],
      ['https://s3-eu-west-1.amazonaws.com', 'eu-west-1'],
      ['https://s3.eu-central-003.backblazeb2.com', 'eu-central-003'],
      ['https://s3.eu-central-1.wasabisys.com', 'eu-central-1'],
      ['https://s3.gra.io.cloud.ovh.net', 'gra'],
      ['https://fsn1.your-objectstorage.com', 'fsn1'],
      ['https://0123abcd.r2.cloudflarestorage.com', 'auto'],
    ];
    for (const [endpoint, region] of cases) assert.equal(regionOf(endpoint), region, endpoint);
  });

  it('is what MinIO answers to everywhere else, and for the global AWS endpoint', () => {
    for (const endpoint of ['http://minio:9000', 'https://s3.amazonaws.com', 'http://127.0.0.1:9000', 'not a url', '']) {
      assert.equal(regionOf(endpoint), 'us-east-1', endpoint);
    }
  });
});

describe('the largest attachment an address is sent', () => {
  it('is ten megabytes unless said otherwise, and a fraction may be said', () => {
    given({});
    assert.equal(env.backup.email.maxBytes, 10 * 1024 * 1024);
    given({ KOLIBRI_BACKUP_EMAIL_MAX_MB: '0.5' });
    assert.equal(env.backup.email.maxBytes, 512 * 1024);
    // Nonsense is the default rather than "never attach".
    for (const nonsense of ['0', '-3', 'lots', '']) {
      given({ KOLIBRI_BACKUP_EMAIL_MAX_MB: nonsense });
      assert.equal(env.backup.email.maxBytes, 10 * 1024 * 1024, nonsense);
    }
  });
});
