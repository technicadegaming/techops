#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FIRESTORE_ARTIFACT_PATTERN = /^cloud-firestore-emulator-v[\d.]+\.jar$/;
const STORAGE_ARTIFACT_PATTERN = /^cloud-storage-rules-runtime-v[\d.]+\.jar$/;

function findArtifact(cacheDir, pattern) {
  if (!fs.existsSync(cacheDir)) return null;
  const entries = fs.readdirSync(cacheDir);
  const match = entries.find((entry) => pattern.test(entry));
  return match ? path.join(cacheDir, match) : null;
}

function runFirebase(args) {
  const result = spawnSync('firebase', args, { stdio: 'inherit', shell: true });
  return result.status ?? 1;
}

function ensureEmulatorArtifacts(cacheDir) {
  const firestoreArtifact = findArtifact(cacheDir, FIRESTORE_ARTIFACT_PATTERN);
  const storageArtifact = findArtifact(cacheDir, STORAGE_ARTIFACT_PATTERN);

  if (firestoreArtifact && storageArtifact) {
    return true;
  }

  console.log('[rules-test] Emulator artifacts missing; attempting first-run setup.');
  const firestoreStatus = runFirebase(['setup:emulators:firestore']);
  if (firestoreStatus !== 0) return false;

  const storageStatus = runFirebase(['setup:emulators:storage']);
  if (storageStatus !== 0) return false;

  const readyFirestoreArtifact = findArtifact(cacheDir, FIRESTORE_ARTIFACT_PATTERN);
  const readyStorageArtifact = findArtifact(cacheDir, STORAGE_ARTIFACT_PATTERN);
  return !!(readyFirestoreArtifact && readyStorageArtifact);
}

function main() {
  const cacheDir = path.join(os.homedir(), '.cache', 'firebase', 'emulators');
  const artifactsReady = ensureEmulatorArtifacts(cacheDir);

  if (!artifactsReady) {
    console.error(`\n[rules-test] Unable to prepare Firebase emulator artifacts in ${cacheDir}.`);
    console.error('[rules-test] Rules assertions were not executed.');
    console.error('[rules-test] Check outbound access to Firebase emulator downloads, then retry:');
    console.error('  firebase setup:emulators:firestore');
    console.error('  firebase setup:emulators:storage');
    process.exit(1);
  }

  const status = runFirebase([
    'emulators:exec',
    '--project',
    'scootbusiness-d3112',
    '--only',
    'firestore,storage',
    'node --test test/rules/security.rules.test.js'
  ]);
  process.exit(status);
}

main();
