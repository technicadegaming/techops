const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function readSource() {
  return fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
}

test('worker pin callables are exported', () => {
  const source = readSource();
  assert.match(source, /exports\.setWorkerLocationPin = onCall\(/);
  assert.match(source, /exports\.signOffChecklistItemWithPin = onCall\(/);
});

test('setWorkerLocationPin enforces auth elevated role and pin format', () => {
  const source = readSource();
  assert.match(source, /if \(!request\.auth\) throw new HttpsError\('unauthenticated'/);
  assert.match(source, /\['owner', 'admin', 'manager'\]\.includes\(role\)/);
  assert.match(source, /PIN must be 4-8 digits/);
  assert.match(source, /const PIN_REGEX = \/\^\\d\{4,8\}\$\//);
});

test('raw PIN is never persisted and only pinHash field is written', () => {
  const source = readSource();
  assert.match(source, /pinHash: createPinHash\(pin\)/);
  assert.doesNotMatch(source, /pin:\s*pin/);
  assert.doesNotMatch(source, /console\.(log|info|warn|error)\([^\n]*pin/i);
});

test('signOffChecklistItemWithPin supports PIN-only lookup and handles ambiguous/bad credentials', () => {
  const source = readSource();
  assert.match(source, /companyId, taskId, checklistItemId, locationId, and pin are required/);
  assert.match(source, /\.where\('companyId', '==', companyId\)/);
  assert.match(source, /\.where\('locationId', '==', locationId\)/);
  assert.match(source, /const matchingPins = pinsSnap\.docs\.filter/);
  assert.match(source, /if \(matchingPins\.length !== 1\)/);
  assert.match(source, /Invalid sign-off credentials/);
});

test('signOffChecklistItemWithPin updates only matching checklist item and stamps pin sign-off metadata', () => {
  const source = readSource();
  assert.match(source, /if \(`\$\{item\.id \|\| ''\}`\.trim\(\) !== checklistItemId\) return item/);
  assert.match(source, /completed: true/);
  assert.match(source, /completedBy: workerLabel/);
  assert.match(source, /signOffMethod: 'pin'/);
  assert.match(source, /lastUsedAt: serverTimestamp\(\)/);
  assert.match(source, /const workerId = `\$\{pinRecord\.workerId \|\| ''\}`\.trim\(\)/);
});

test('setWorkerLocationPin rejects duplicate PINs for other workers while allowing same-worker reset', () => {
  const source = readSource();
  assert.match(source, /const duplicatePin = existingPinsSnap\.docs\.find/);
  assert.match(source, /if \(duplicatePin\)/);
  assert.match(source, /PIN is already in use at this location/);
  assert.match(source, /if \(`\$\{data\.workerId \|\| ''\}`\.trim\(\) === workerId\) return false/);
});
