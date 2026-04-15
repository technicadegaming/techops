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

function describeCommand(command, args) {
  return `${command} ${args.join(' ')}`;
}

function runCommand(command, args) {
  const printable = describeCommand(command, args);
  console.log(`[rules-test] Running: ${printable}`);

  const result = spawnSync(command, args, { stdio: 'inherit' });

  if (result.error) {
    console.error(`[rules-test] Failed to start command: ${printable}`);
    console.error(`[rules-test] ${result.error.stack || result.error.message}`);
    return { status: 1, command: printable, startupError: result.error };
  }

  if (result.signal) {
    console.error(`[rules-test] Command terminated by signal ${result.signal}: ${printable}`);
    return { status: 1, command: printable, signal: result.signal };
  }

  return { status: result.status ?? 1, command: printable };
}

function runFirebase(args) {
  return runCommand('firebase', args);
}

function ensureEmulatorArtifacts(cacheDir) {
  const firestoreArtifact = findArtifact(cacheDir, FIRESTORE_ARTIFACT_PATTERN);
  const storageArtifact = findArtifact(cacheDir, STORAGE_ARTIFACT_PATTERN);

  if (firestoreArtifact && storageArtifact) {
    console.log('[rules-test] Emulator artifacts already present.');
    return { ready: true };
  }

  console.log('[rules-test] Emulator artifacts missing; attempting first-run setup.');
  const firestoreSetup = runFirebase(['setup:emulators:firestore']);
  if (firestoreSetup.status !== 0) {
    return { ready: false, failedStep: 'firestore setup', result: firestoreSetup };
  }

  const storageSetup = runFirebase(['setup:emulators:storage']);
  if (storageSetup.status !== 0) {
    return { ready: false, failedStep: 'storage setup', result: storageSetup };
  }

  const readyFirestoreArtifact = findArtifact(cacheDir, FIRESTORE_ARTIFACT_PATTERN);
  const readyStorageArtifact = findArtifact(cacheDir, STORAGE_ARTIFACT_PATTERN);
  if (readyFirestoreArtifact && readyStorageArtifact) {
    return { ready: true };
  }

  return { ready: false, failedStep: 'artifact verification' };
}

function logSetupFailure(cacheDir, setupState) {
  console.error(`\n[rules-test] Emulator setup failed (${setupState.failedStep || 'unknown step'}).`);
  if (setupState.result) {
    console.error(`[rules-test] Failing command: ${setupState.result.command}`);
    console.error(`[rules-test] Exit code: ${setupState.result.status}`);
  }
  console.error(`[rules-test] Unable to prepare Firebase emulator artifacts in ${cacheDir}.`);
  console.error('[rules-test] Rules assertions were not executed.');
  console.error('[rules-test] Check outbound access to Firebase emulator downloads, then retry:');
  console.error('  firebase setup:emulators:firestore');
  console.error('  firebase setup:emulators:storage');
}

function main() {
  const cacheDir = path.join(os.homedir(), '.cache', 'firebase', 'emulators');
  const setupState = ensureEmulatorArtifacts(cacheDir);

  if (!setupState.ready) {
    logSetupFailure(cacheDir, setupState);
    process.exit(1);
  }

  const testRun = runFirebase([
    'emulators:exec',
    '--project',
    'scootbusiness-d3112',
    '--only',
    'firestore,storage',
    'node --test test/rules/security.rules.test.js'
  ]);

  if (testRun.status !== 0) {
    console.error(`\n[rules-test] Rules test command failed: ${testRun.command}`);
    console.error(`[rules-test] Exit code: ${testRun.status}`);
    process.exit(testRun.status);
  }

  console.log('[rules-test] Rules tests passed.');
}

process.on('uncaughtException', (error) => {
  console.error('[rules-test] Unexpected uncaught exception.');
  console.error(error && (error.stack || error.message) ? error.stack || error.message : error);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[rules-test] Unexpected unhandled promise rejection.');
  if (reason && reason.stack) {
    console.error(reason.stack);
  } else {
    console.error(reason);
  }
  process.exit(1);
});

main();
