#!/usr/bin/env node
// Generates the RSA key that signs texture properties. Print it to stdout so
// it can be piped straight into `wrangler secret put SIGNING_KEY`.
import { generateKeyPairSync } from 'node:crypto';

const bits = Number(process.argv.find((arg) => arg.startsWith('--bits='))?.slice(7)) || 4096;

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: bits,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

process.stdout.write(privateKey);
