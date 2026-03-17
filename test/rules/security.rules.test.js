const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} = require('@firebase/rules-unit-testing');
const {
  doc,
  getDoc,
  setDoc,
} = require('firebase/firestore');
const {
  ref,
  uploadString,
  getBytes,
  deleteObject,
} = require('firebase/storage');

const projectId = process.env.GCLOUD_PROJECT || 'techops-rules';
const rulesTestEnvPromise = initializeTestEnvironment({
  projectId,
  firestore: {
    rules: fs.readFileSync(path.resolve(__dirname, '../../firestore.rules'), 'utf8'),
  },
  storage: {
    rules: fs.readFileSync(path.resolve(__dirname, '../../storage.rules'), 'utf8'),
  },
});

async function seedMembership({ uid, companyId, role = 'staff', status = 'active', userRole = 'staff' }) {
  const testEnv = await rulesTestEnvPromise;
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();

    await setDoc(doc(db, 'users', uid), {
      role: userRole,
      enabled: true,
    });

    await setDoc(doc(db, 'companies', companyId), {
      id: companyId,
      createdBy: uid,
    });

    await setDoc(doc(db, 'companyMemberships', `${companyId}_${uid}`), {
      id: `${companyId}_${uid}`,
      companyId,
      userId: uid,
      role,
      status,
    });
  });
}

test.beforeEach(async () => {
  const testEnv = await rulesTestEnvPromise;
  await testEnv.clearFirestore();
  await testEnv.clearStorage();
});

test.after(async () => {
  const testEnv = await rulesTestEnvPromise;
  await testEnv.cleanup();
});

test('firestore: company member can read and create own company scoped assets', async () => {
  await seedMembership({ uid: 'manager-a', companyId: 'company-a', role: 'manager' });
  const testEnv = await rulesTestEnvPromise;

  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'assets', 'asset-a'), {
      companyId: 'company-a',
      name: 'Skee Ball',
    });
  });

  const db = testEnv.authenticatedContext('manager-a').firestore();
  await assertSucceeds(getDoc(doc(db, 'assets', 'asset-a')));
  await assertSucceeds(setDoc(doc(db, 'assets', 'asset-new'), { companyId: 'company-a', name: 'Air Hockey' }));
});

test('firestore: cross-company access is denied', async () => {
  await seedMembership({ uid: 'manager-a', companyId: 'company-a', role: 'manager' });
  await seedMembership({ uid: 'manager-b', companyId: 'company-b', role: 'manager' });
  const testEnv = await rulesTestEnvPromise;

  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'assets', 'asset-b'), {
      companyId: 'company-b',
      name: 'Claw Machine',
    });
  });

  const db = testEnv.authenticatedContext('manager-a').firestore();
  await assertFails(getDoc(doc(db, 'assets', 'asset-b')));
});

test('firestore: signed-in non-member is denied company-scoped docs', async () => {
  await seedMembership({ uid: 'manager-a', companyId: 'company-a', role: 'manager' });
  const testEnv = await rulesTestEnvPromise;

  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'assets', 'asset-a'), {
      companyId: 'company-a',
      name: 'Racing Game',
    });
    await setDoc(doc(context.firestore(), 'users', 'outsider'), {
      role: 'staff',
      enabled: true,
    });
  });

  const outsiderDb = testEnv.authenticatedContext('outsider').firestore();
  await assertFails(getDoc(doc(outsiderDb, 'assets', 'asset-a')));
});

test('firestore: role-sensitive behavior enforces elevated-only app settings writes', async () => {
  await seedMembership({ uid: 'manager-a', companyId: 'company-a', role: 'manager' });
  await seedMembership({ uid: 'lead-a', companyId: 'company-a', role: 'lead' });
  const testEnv = await rulesTestEnvPromise;

  const managerDb = testEnv.authenticatedContext('manager-a').firestore();
  const leadDb = testEnv.authenticatedContext('lead-a').firestore();

  await assertSucceeds(
    setDoc(doc(managerDb, 'appSettings', 'settings-a'), {
      companyId: 'company-a',
      timezone: 'UTC',
    }),
  );

  await assertFails(
    setDoc(doc(leadDb, 'appSettings', 'settings-b'), {
      companyId: 'company-a',
      timezone: 'UTC',
    }),
  );
});

test('storage: company evidence path allows active member and blocks cross-company access', async () => {
  await seedMembership({ uid: 'staff-a', companyId: 'company-a', role: 'staff' });
  await seedMembership({ uid: 'staff-b', companyId: 'company-b', role: 'staff' });
  const testEnv = await rulesTestEnvPromise;

  const staffAStorage = testEnv.authenticatedContext('staff-a').storage();
  const staffBStorage = testEnv.authenticatedContext('staff-b').storage();

  await assertSucceeds(uploadString(ref(staffAStorage, 'companies/company-a/evidence/photo.jpg'), 'ok'));
  await assertSucceeds(getBytes(ref(staffAStorage, 'companies/company-a/evidence/photo.jpg')));

  await assertFails(getBytes(ref(staffBStorage, 'companies/company-a/evidence/photo.jpg')));
  await assertFails(uploadString(ref(staffBStorage, 'companies/company-a/evidence/other.jpg'), 'nope'));
});

test('storage: backups path is admin/owner scoped for company members', async () => {
  await seedMembership({ uid: 'owner-a', companyId: 'company-a', role: 'owner' });
  await seedMembership({ uid: 'staff-a', companyId: 'company-a', role: 'staff' });
  const testEnv = await rulesTestEnvPromise;

  const ownerStorage = testEnv.authenticatedContext('owner-a').storage();
  const staffStorage = testEnv.authenticatedContext('staff-a').storage();

  await assertSucceeds(uploadString(ref(ownerStorage, 'companies/company-a/backups/snapshot.json'), '{}'));
  await assertFails(uploadString(ref(staffStorage, 'companies/company-a/backups/blocked.json'), '{}'));
  await assertFails(getBytes(ref(staffStorage, 'companies/company-a/backups/snapshot.json')));
});

test('storage: legacy root paths are denied for regular members and allowed for global admins', async () => {
  await seedMembership({ uid: 'staff-a', companyId: 'company-a', role: 'staff' });
  await seedMembership({ uid: 'global-admin', companyId: 'company-a', role: 'staff', userRole: 'admin' });
  const testEnv = await rulesTestEnvPromise;

  const staffStorage = testEnv.authenticatedContext('staff-a').storage();
  const adminStorage = testEnv.authenticatedContext('global-admin').storage();

  await assertFails(uploadString(ref(staffStorage, 'evidence/legacy.jpg'), 'x'));
  await assertFails(uploadString(ref(staffStorage, 'backups/legacy.zip'), 'x'));

  await assertSucceeds(uploadString(ref(adminStorage, 'evidence/legacy.jpg'), 'x'));
  await assertSucceeds(uploadString(ref(adminStorage, 'backups/legacy.zip'), 'x'));
  await assertSucceeds(deleteObject(ref(adminStorage, 'evidence/legacy.jpg')));
});


test('storage: task-scoped evidence path shape supports own company and blocks cross-company writes', async () => {
  await seedMembership({ uid: 'lead-a', companyId: 'company-a', role: 'lead' });
  await seedMembership({ uid: 'lead-b', companyId: 'company-b', role: 'lead' });
  const testEnv = await rulesTestEnvPromise;

  const leadAStorage = testEnv.authenticatedContext('lead-a').storage();
  const leadBStorage = testEnv.authenticatedContext('lead-b').storage();

  const ownPath = 'companies/company-a/evidence/task-123/photo-1.jpg';
  const crossPath = 'companies/company-a/evidence/task-123/photo-2.jpg';

  await assertSucceeds(uploadString(ref(leadAStorage, ownPath), 'ok'));
  await assertSucceeds(getBytes(ref(leadAStorage, ownPath)));
  await assertFails(uploadString(ref(leadBStorage, crossPath), 'nope'));
});
