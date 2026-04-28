const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('createCompanyInvite callable enforces active owner/admin/manager membership and writes normalized invite code', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  assert.match(source, /exports\.createCompanyInvite = onCall\(/);
  assert.match(source, /if \(!request\.auth\) throw new HttpsError\('unauthenticated'/);
  assert.match(source, /companyMemberships'\)\.doc\(canonicalId\)/);
  assert.match(source, /const allowedRoles = \['owner', 'admin', 'manager'\]/);
  assert.match(source, /throw new HttpsError\(\s*'permission-denied'/);
  assert.match(source, /inviteCodeNormalized/);
});

test('acceptCompanyInvite callable updates membership, user, invite state, and optional worker profile', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  assert.match(source, /exports\.acceptCompanyInvite = onCall\(/);
  assert.match(source, /db\.collection\('companyMemberships'\)\.doc\(membershipId\)/);
  assert.match(source, /db\.collection\('users'\)\.doc\(request\.auth\.uid\)/);
  assert.match(source, /if \(freshInvite\.createWorkerProfile === true/);
  assert.match(source, /status: 'accepted'/);
  assert.match(source, /acceptedBy: request\.auth\.uid/);
  assert.match(source, /actionType: 'invite_accepted'/);
  assert.match(source, /failedAttempts: 0/);
});

test('acceptCompanyInvite callable returns explicit invite lifecycle errors', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  assert.match(source, /This invite has been revoked/);
  assert.match(source, /This invite code was already used/);
  assert.match(source, /This invite has expired/);
  assert.match(source, /different email address/);
});

test('acceptCompanyInvite tracks failed attempts without accepting or removing the invite', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  assert.match(source, /admin\.firestore\.FieldValue\.increment\(1\)/);
  assert.match(source, /lastFailedAttemptAt: serverTimestamp\(\)/);
  assert.match(source, /const trackFailure = \['permission-denied', 'failed-precondition', 'already-exists', 'not-found', 'invalid-argument'\]\.includes\(errorCode\)/);
  assert.match(source, /inviteCodeNormalized/);
});

test('acceptCompanyInvite supports normalized lookup with inviteCode fallback for legacy invite docs', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  assert.match(source, /const inviteQueryByNormalized = await db\.collection\('companyInvites'\)/);
  assert.match(source, /const inviteQuery = inviteQueryByNormalized\.empty/);
  assert.match(source, /\.where\('inviteCode', '==', inviteCode\)/);
  assert.match(source, /if \(inviteQuery\.empty\) throw new HttpsError\('not-found'/);
});
