#!/usr/bin/env node
/**
 * R2 CORS configuration + end-to-end validation (HARD GATE before client rollout).
 *
 * The mobile sync engine and web uploader both PUT directly to a presigned URL
 * via raw fetch; a CORS misconfiguration fails silently in the browser/RN. This
 * script:
 *   1. (optional) Applies a CORS policy to the bucket allowing PUT/GET from the
 *      configured web + mobile origins.   -> `--apply`
 *   2. Prints the current bucket CORS.
 *   3. Runs a presigned PUT -> GET round-trip with a throwaway object and
 *      verifies the bytes match, then deletes it.
 *
 * Usage:
 *   node scripts/validateR2Cors.js            # validate round-trip + print CORS
 *   node scripts/validateR2Cors.js --apply    # also (re)apply CORS policy first
 *
 * Origins are taken from FRONTEND_URL plus a permissive set for mobile (RN has
 * no fixed web origin; Cloudflare R2 treats `*` as allow-any). Adjust as needed.
 */

require('dotenv').config();

const {
  PutBucketCorsCommand,
  GetBucketCorsCommand
} = require('@aws-sdk/client-s3');
const env = require('../src/config/env');
const r2 = require('../src/services/storage/r2.client');

const APPLY = process.argv.includes('--apply');

function corsRules() {
  const origins = new Set(['*']);
  if (env.FRONTEND_URL) origins.add(env.FRONTEND_URL.replace(/\/$/, ''));
  return [
    {
      AllowedMethods: ['GET', 'PUT', 'HEAD'],
      AllowedOrigins: Array.from(origins),
      AllowedHeaders: ['*'],
      ExposeHeaders: ['ETag'],
      MaxAgeSeconds: 3600
    }
  ];
}

/** Cloudflare dashboard expects this JSON shape (R2 → bucket → Settings → CORS Policy). */
function dashboardCorsJson() {
  return JSON.stringify(
    corsRules().map((r) => ({
      AllowedOrigins: r.AllowedOrigins,
      AllowedMethods: r.AllowedMethods,
      AllowedHeaders: r.AllowedHeaders,
      ExposeHeaders: r.ExposeHeaders,
      MaxAgeSeconds: r.MaxAgeSeconds
    })),
    null,
    2
  );
}

function printDashboardInstructions() {
  console.log(
    '\nApply this CORS policy manually in the Cloudflare dashboard:\n' +
      '  R2 → your bucket → Settings → CORS Policy → Edit → paste:\n'
  );
  console.log(dashboardCorsJson());
  console.log(
    '\n(or re-run this script with an R2 API token that has "Admin Read & Write" permissions.)'
  );
}

async function applyCors() {
  const client = r2.getClient();
  try {
    await client.send(
      new PutBucketCorsCommand({
        Bucket: r2.getBucket(),
        CORSConfiguration: { CORSRules: corsRules() }
      })
    );
    console.log('✓ Applied CORS policy to bucket', r2.getBucket());
    return true;
  } catch (err) {
    const code = err && (err.name || err.Code);
    if (code === 'AccessDenied' || (err && err.$metadata && err.$metadata.httpStatusCode === 403)) {
      console.warn(
        '⚠ Could not apply CORS via the S3 API (Access Denied). Your R2 token can read/write\n' +
          '  objects but cannot edit bucket CORS. This is expected for object-scoped tokens.'
      );
      printDashboardInstructions();
      return false;
    }
    throw err;
  }
}

async function printCors() {
  const client = r2.getClient();
  try {
    const res = await client.send(new GetBucketCorsCommand({ Bucket: r2.getBucket() }));
    console.log('Current bucket CORS rules:');
    console.log(JSON.stringify(res.CORSRules, null, 2));
  } catch (err) {
    console.warn('Could not read bucket CORS (this may be normal on some R2 plans):', err.message);
  }
}

async function roundTrip() {
  const key = `cors-check/${Date.now()}-${Math.random().toString(36).slice(2)}.txt`;
  const payload = `r2-cors-check ${new Date().toISOString()}`;
  const contentType = 'text/plain';

  const { url: putUrl } = await r2.getPresignedPutUrl({ key, contentType });
  const putRes = await fetch(putUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: payload
  });
  if (!putRes.ok) {
    throw new Error(`Presigned PUT failed: ${putRes.status} ${putRes.statusText}`);
  }
  console.log('✓ Presigned PUT upload succeeded');

  const { url: getUrl } = await r2.getPresignedGetUrl({ key });
  const getRes = await fetch(getUrl);
  if (!getRes.ok) {
    throw new Error(`Presigned GET failed: ${getRes.status} ${getRes.statusText}`);
  }
  const body = await getRes.text();
  if (body !== payload) {
    throw new Error('Round-trip body mismatch: downloaded content does not match uploaded content');
  }
  console.log('✓ Presigned GET download matched uploaded bytes');

  await r2.deleteObject({ key });
  console.log('✓ Cleanup delete succeeded (idempotent)');
}

async function main() {
  if (!r2.isConfigured()) {
    console.error(
      'R2 is not configured. Set MEDIA_STORAGE_PROVIDER=r2 and R2_* env vars before running this check.'
    );
    process.exit(1);
  }
  console.log('R2 endpoint:', r2.resolveEndpoint());
  console.log('R2 bucket  :', r2.getBucket());

  if (APPLY) await applyCors();
  await printCors();
  await roundTrip();

  console.log(
    '\nObject presign round-trip PASSED (server-side). NOTE: browser CORS can only be\n' +
      'verified from a real browser origin — ensure the CORS policy above is applied so\n' +
      'direct PUT/GET from the web app succeeds.'
  );
}

main().catch((err) => {
  console.error('\nR2 CORS VALIDATION FAILED:', err.message);
  console.error('Do NOT start mobile/web media integration until this passes.');
  process.exit(1);
});
