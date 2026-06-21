const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const env = require('../../config/env');
const logger = require('../../utils/logger');

/**
 * Cloudflare R2 storage provider (S3-compatible).
 *
 * The bucket is PRIVATE: there are no public object URLs. All access happens
 * through short-lived presigned URLs (see MEDIA_*_TTL_SECONDS). This module is
 * the single, centralized abstraction over the object store so the rest of the
 * codebase never talks to the S3 SDK directly.
 */

let cachedClient = null;

function isConfigured() {
  return (
    env.MEDIA_STORAGE_PROVIDER === 'r2' &&
    !!env.R2_ACCESS_KEY_ID &&
    !!env.R2_SECRET_ACCESS_KEY &&
    !!env.R2_BUCKET &&
    (!!env.R2_ENDPOINT || !!env.R2_ACCOUNT_ID)
  );
}

function resolveEndpoint() {
  if (env.R2_ENDPOINT) return env.R2_ENDPOINT.replace(/\/$/, '');
  if (env.R2_ACCOUNT_ID) {
    return `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  }
  return '';
}

function getClient() {
  if (!isConfigured()) {
    throw new Error('R2 storage is not configured (check MEDIA_STORAGE_PROVIDER and R2_* env vars).');
  }
  if (!cachedClient) {
    cachedClient = new S3Client({
      region: env.R2_REGION || 'auto',
      endpoint: resolveEndpoint(),
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY
      },
      // R2 requires path-style addressing.
      forcePathStyle: true,
      // AWS SDK v3 (>=3.729) defaults to WHEN_SUPPORTED, which bakes a CRC32
      // checksum (x-amz-checksum-crc32) of an EMPTY body into presigned PUT URLs.
      // Browsers/RN then upload the real bytes, the checksum no longer matches,
      // and R2 rejects the upload (and the extra signed headers also trip CORS).
      // WHEN_REQUIRED keeps presigned URLs clean so direct client PUTs work.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED'
    });
  }
  return cachedClient;
}

function getBucket() {
  return env.R2_BUCKET;
}

/**
 * Presigned PUT URL for a direct client upload. Short-lived.
 */
async function getPresignedPutUrl({ key, contentType, expiresIn }) {
  const ttl = expiresIn || env.MEDIA_UPLOAD_URL_TTL_SECONDS;
  const command = new PutObjectCommand({
    Bucket: getBucket(),
    Key: key,
    ContentType: contentType
  });
  const url = await getSignedUrl(getClient(), command, { expiresIn: ttl });
  return { url, expiresIn: ttl };
}

/**
 * Presigned GET URL for a download/render. Short-lived.
 */
async function getPresignedGetUrl({ key, expiresIn }) {
  const ttl = expiresIn || env.MEDIA_DOWNLOAD_URL_TTL_SECONDS;
  const command = new GetObjectCommand({
    Bucket: getBucket(),
    Key: key
  });
  const url = await getSignedUrl(getClient(), command, { expiresIn: ttl });
  return { url, expiresIn: ttl };
}

/**
 * Delete an object. Idempotent: deleting a missing key resolves successfully
 * (S3/R2 DeleteObject returns 204 even when the key is absent). NoSuchKey/404
 * is treated as success so cleanup retries are safe.
 */
async function deleteObject({ key }) {
  try {
    await getClient().send(
      new DeleteObjectCommand({ Bucket: getBucket(), Key: key })
    );
    return { deleted: true };
  } catch (err) {
    const code = err && (err.name || err.Code);
    const status = err && err.$metadata && err.$metadata.httpStatusCode;
    if (code === 'NoSuchKey' || status === 404) {
      return { deleted: true, alreadyAbsent: true };
    }
    logger.error('R2 deleteObject failed', { key, error: err && err.message });
    throw err;
  }
}

module.exports = {
  isConfigured,
  getClient,
  getBucket,
  getPresignedPutUrl,
  getPresignedGetUrl,
  deleteObject,
  resolveEndpoint
};
