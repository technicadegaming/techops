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
  deleteDoc,
  setDoc,
} = require('firebase/firestore');
const {
  ref,
  uploadString,
  getBytes,
  deleteObject,
} = require('firebase/storage');

const projectId = process.env.GCLOUD_PROJECT || 'scootbusiness-d3112';
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

test('firestore: active staff can create same-company tasks but cannot create cross-company tasks', async () => {
  await seedMembership({ uid: 'staff-a', companyId: 'company-a', role: 'staff' });
  await seedMembership({ uid: 'staff-a-other', companyId: 'company-b', role: 'staff' });
  const testEnv = await rulesTestEnvPromise;
  const staffDb = testEnv.authenticatedContext('staff-a').firestore();

  await assertSucceeds(
    setDoc(doc(staffDb, 'tasks', 'task-a'), {
      id: 'task-a',
      companyId: 'company-a',
      title: 'Quik Drop down',
      status: 'open',
    }),
  );

  await assertFails(
    setDoc(doc(staffDb, 'tasks', 'task-cross'), {
      id: 'task-cross',
      companyId: 'company-b',
      title: 'Cross-company task',
      status: 'open',
    }),
  );
});

test('firestore: active staff cannot update or delete arbitrary tasks', async () => {
  await seedMembership({ uid: 'staff-a', companyId: 'company-a', role: 'staff' });
  await seedMembership({ uid: 'lead-a', companyId: 'company-a', role: 'lead' });
  const testEnv = await rulesTestEnvPromise;

  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'tasks', 'task-owned-by-lead'), {
      id: 'task-owned-by-lead',
      companyId: 'company-a',
      title: 'Existing task',
      status: 'open',
      description: 'Initial',
    });
  });

  const staffDb = testEnv.authenticatedContext('staff-a').firestore();
  await assertFails(
    setDoc(doc(staffDb, 'tasks', 'task-owned-by-lead'), {
      id: 'task-owned-by-lead',
      companyId: 'company-a',
      title: 'Edited by staff',
      status: 'completed',
      description: 'Changed',
    }),
  );
  await assertFails(
    setDoc(doc(staffDb, 'tasks', 'task-owned-by-lead'), {
      id: 'task-owned-by-lead',
      companyId: 'company-a',
      title: 'Edited by staff',
      status: 'open',
    }, { merge: true }),
  );
  await assertFails(deleteDoc(doc(staffDb, 'tasks', 'task-owned-by-lead')));
});

test('firestore: first user can create company and own owner membership during bootstrap', async () => {
  const testEnv = await rulesTestEnvPromise;
  const uid = 'first-user';
  const companyId = 'company-first';
  const membershipId = `${companyId}_${uid}`;

  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'users', uid), {
      role: 'pending',
      enabled: true,
    });
  });

  const db = testEnv.authenticatedContext(uid).firestore();

  await assertSucceeds(
    setDoc(doc(db, 'companies', companyId), {
      id: companyId,
      name: 'First Workspace',
      createdBy: uid,
    }),
  );

  await assertSucceeds(
    setDoc(doc(db, 'companyMemberships', membershipId), {
      id: membershipId,
      companyId,
      userId: uid,
      role: 'owner',
      status: 'active',
      createdBy: uid,
    }),
  );
});

test('firestore: first user bootstrap cannot create owner membership for another user', async () => {
  const testEnv = await rulesTestEnvPromise;
  const uid = 'first-user';
  const companyId = 'company-first';

  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'users', uid), {
      role: 'pending',
      enabled: true,
    });
  });

  const db = testEnv.authenticatedContext(uid).firestore();
  await assertSucceeds(
    setDoc(doc(db, 'companies', companyId), {
      id: companyId,
      name: 'First Workspace',
      createdBy: uid,
    }),
  );

  await assertFails(
    setDoc(doc(db, 'companyMemberships', `${companyId}_other-user`), {
      id: `${companyId}_other-user`,
      companyId,
      userId: 'other-user',
      role: 'owner',
      status: 'active',
      createdBy: uid,
    }),
  );
});

test('firestore: first user bootstrap cannot create membership with malformed id format', async () => {
  const testEnv = await rulesTestEnvPromise;
  const uid = 'first-user';
  const companyId = 'company-first';

  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'users', uid), {
      role: 'pending',
      enabled: true,
    });
  });

  const db = testEnv.authenticatedContext(uid).firestore();
  await assertSucceeds(
    setDoc(doc(db, 'companies', companyId), {
      id: companyId,
      name: 'First Workspace',
      createdBy: uid,
    }),
  );

  await assertFails(
    setDoc(doc(db, 'companyMemberships', `${uid}_${companyId}`), {
      id: `${uid}_${companyId}`,
      companyId,
      userId: uid,
      role: 'owner',
      status: 'active',
      createdBy: uid,
    }),
  );
});

test('firestore: user can create and update own profile without changing role', async () => {
  const testEnv = await rulesTestEnvPromise;
  const uid = 'profile-self';
  const db = testEnv.authenticatedContext(uid).firestore();

  await assertSucceeds(
    setDoc(doc(db, 'users', uid), {
      id: uid,
      role: 'pending',
      enabled: true,
      fullName: 'Initial Name',
    }),
  );

  await assertSucceeds(
    setDoc(doc(db, 'users', uid), {
      fullName: 'Updated Name',
      role: 'pending',
      emailVerified: true,
    }, { merge: true }),
  );
});

test('firestore: user cannot normalize an explicitly empty legacy role during self-update', async () => {
  const testEnv = await rulesTestEnvPromise;
  const uid = 'legacy-empty-role';

  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'users', uid), {
      id: uid,
      role: '',
      enabled: true,
      fullName: 'Legacy User',
    });
  });

  const db = testEnv.authenticatedContext(uid).firestore();

  await assertFails(
    setDoc(doc(db, 'users', uid), {
      role: 'pending',
      fullName: 'Legacy User',
    }, { merge: true }),
  );
});



test('firestore: checklist templates allow elevated writes and staff reads only within own company', async () => {
  await seedMembership({ uid: 'manager-a', companyId: 'company-a', role: 'manager' });
  await seedMembership({ uid: 'staff-a', companyId: 'company-a', role: 'staff' });
  await seedMembership({ uid: 'manager-b', companyId: 'company-b', role: 'manager' });
  const testEnv = await rulesTestEnvPromise;

  const managerDb = testEnv.authenticatedContext('manager-a').firestore();
  const staffDb = testEnv.authenticatedContext('staff-a').firestore();

  await assertSucceeds(setDoc(doc(managerDb, 'checklistTemplates', 'template-a'), {
    id: 'template-a',
    companyId: 'company-a',
    templateType: 'opening',
    name: 'Opening checklist',
  }));

  await assertSucceeds(getDoc(doc(staffDb, 'checklistTemplates', 'template-a')));
  await assertSucceeds(setDoc(doc(managerDb, 'checklistTemplates', 'template-a'), { name: 'Opening checklist v2' }, { merge: true }));
  await assertSucceeds(deleteDoc(doc(managerDb, 'checklistTemplates', 'template-a')));
});

test('firestore: checklist templates deny cross-company reads and writes', async () => {
  await seedMembership({ uid: 'manager-a', companyId: 'company-a', role: 'manager' });
  await seedMembership({ uid: 'manager-b', companyId: 'company-b', role: 'manager' });
  const testEnv = await rulesTestEnvPromise;

  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'checklistTemplates', 'template-b'), {
      id: 'template-b',
      companyId: 'company-b',
      templateType: 'closing',
      name: 'Company B close',
    });
  });

  const managerDb = testEnv.authenticatedContext('manager-a').firestore();
  await assertFails(getDoc(doc(managerDb, 'checklistTemplates', 'template-b')));
  await assertFails(setDoc(doc(managerDb, 'checklistTemplates', 'template-cross-write'), {
    id: 'template-cross-write',
    companyId: 'company-b',
    templateType: 'upkeep',
    name: 'Cross-company write',
  }));
});

test('firestore: checklist signoff events are read-only for elevated lead+ roles and deny client writes', async () => {
  await seedMembership({ uid: 'lead-a', companyId: 'company-a', role: 'lead' });
  await seedMembership({ uid: 'manager-a', companyId: 'company-a', role: 'manager' });
  await seedMembership({ uid: 'manager-b', companyId: 'company-b', role: 'manager' });
  const testEnv = await rulesTestEnvPromise;

  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'checklistSignoffEvents', 'event-a'), {
      id: 'event-a',
      companyId: 'company-a',
      taskId: 'task-1',
      signedOffBy: 'worker-1',
    });
  });

  const managerDb = testEnv.authenticatedContext('manager-a').firestore();
  const leadDb = testEnv.authenticatedContext('lead-a').firestore();
  const crossDb = testEnv.authenticatedContext('manager-b').firestore();

  await assertSucceeds(getDoc(doc(managerDb, 'checklistSignoffEvents', 'event-a')));
  await assertSucceeds(getDoc(doc(leadDb, 'checklistSignoffEvents', 'event-a')));
  await assertFails(getDoc(doc(crossDb, 'checklistSignoffEvents', 'event-a')));

  await assertFails(setDoc(doc(managerDb, 'checklistSignoffEvents', 'event-client-create'), {
    id: 'event-client-create',
    companyId: 'company-a',
    taskId: 'task-2',
  }));
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

test('storage: manuals path allows same-company access and blocks cross-company access', async () => {
  await seedMembership({ uid: 'staff-a', companyId: 'company-a', role: 'staff' });
  await seedMembership({ uid: 'staff-b', companyId: 'company-b', role: 'staff' });
  const testEnv = await rulesTestEnvPromise;

  const staffAStorage = testEnv.authenticatedContext('staff-a').storage();
  const staffBStorage = testEnv.authenticatedContext('staff-b').storage();
  const ownPath = 'companies/company-a/manuals/asset-1/manual-1/source.pdf';

  await assertSucceeds(uploadString(ref(staffAStorage, ownPath), 'manual-pdf'));
  await assertSucceeds(getBytes(ref(staffAStorage, ownPath)));
  await assertFails(getBytes(ref(staffBStorage, ownPath)));
  await assertFails(uploadString(ref(staffBStorage, 'companies/company-a/manuals/asset-1/manual-2/source.pdf'), 'blocked'));
});

test('storage: asset-manual-bootstrap path allows same-company access and blocks unauthorized reads', async () => {
  await seedMembership({ uid: 'staff-a', companyId: 'company-a', role: 'staff' });
  await seedMembership({ uid: 'staff-b', companyId: 'company-b', role: 'staff' });
  const testEnv = await rulesTestEnvPromise;

  const staffAStorage = testEnv.authenticatedContext('staff-a').storage();
  const staffBStorage = testEnv.authenticatedContext('staff-b').storage();
  const ownPath = 'companies/company-a/asset-manual-bootstrap/asset-1/manual.pdf';
  const crossCompanyPath = 'companies/company-b/asset-manual-bootstrap/asset-2/manual.pdf';

  await assertSucceeds(uploadString(ref(staffAStorage, ownPath), 'manual-pdf'));
  await assertSucceeds(getBytes(ref(staffAStorage, ownPath)));

  await assertFails(getBytes(ref(staffBStorage, ownPath)));
  await assertFails(uploadString(ref(staffBStorage, 'companies/company-a/asset-manual-bootstrap/asset-1/blocked.pdf'), 'blocked'));

  await testEnv.withSecurityRulesDisabled(async (context) => {
    await uploadString(ref(context.storage(), crossCompanyPath), 'manual-pdf-b');
  });
  await assertSucceeds(getBytes(ref(staffBStorage, crossCompanyPath)));
  await assertFails(getBytes(ref(staffAStorage, crossCompanyPath)));
});

test('storage: company branding logo path allows profile-edit roles and blocks cross-company writes', async () => {
  await seedMembership({ uid: 'owner-a', companyId: 'company-a', role: 'owner' });
  await seedMembership({ uid: 'manager-a', companyId: 'company-a', role: 'manager' });
  await seedMembership({ uid: 'staff-a', companyId: 'company-a', role: 'staff' });
  await seedMembership({ uid: 'manager-b', companyId: 'company-b', role: 'manager' });
  const testEnv = await rulesTestEnvPromise;

  const ownerStorage = testEnv.authenticatedContext('owner-a').storage();
  const managerStorage = testEnv.authenticatedContext('manager-a').storage();
  const staffStorage = testEnv.authenticatedContext('staff-a').storage();
  const crossCompanyStorage = testEnv.authenticatedContext('manager-b').storage();
  const logoPath = 'companies/company-a/branding/logo/company-logo.png';

  await assertSucceeds(uploadString(ref(ownerStorage, logoPath), 'logo-owner'));
  await assertSucceeds(uploadString(ref(managerStorage, logoPath), 'logo-manager'));
  await assertSucceeds(getBytes(ref(staffStorage, logoPath)));
  await assertFails(uploadString(ref(staffStorage, logoPath), 'logo-staff-blocked'));
  await assertFails(uploadString(ref(crossCompanyStorage, logoPath), 'logo-cross-company-blocked'));
});

test('storage: shared manual-library path allows enabled signed-in reads but blocks writes', async () => {
  await seedMembership({ uid: 'staff-a', companyId: 'company-a', role: 'staff' });
  const testEnv = await rulesTestEnvPromise;

  await testEnv.withSecurityRulesDisabled(async (context) => {
    await uploadString(ref(context.storage(), 'manual-library/bay-tek/quik-drop/manual.pdf'), 'manual-pdf');
  });

  const staffStorage = testEnv.authenticatedContext('staff-a').storage();
  await assertSucceeds(getBytes(ref(staffStorage, 'manual-library/bay-tek/quik-drop/manual.pdf')));
  await assertFails(uploadString(ref(staffStorage, 'manual-library/bay-tek/quik-drop/manual-v2.pdf'), 'blocked'));
});

test('storage: manual-library read access does not grant access to unrelated company evidence paths', async () => {
  await seedMembership({ uid: 'staff-a', companyId: 'company-a', role: 'staff' });
  await seedMembership({ uid: 'staff-b', companyId: 'company-b', role: 'staff' });
  const testEnv = await rulesTestEnvPromise;

  await testEnv.withSecurityRulesDisabled(async (context) => {
    await uploadString(ref(context.storage(), 'companies/company-a/evidence/protected.jpg'), 'sensitive');
    await uploadString(ref(context.storage(), 'manual-library/shared/manual.pdf'), 'manual');
  });

  const staffBStorage = testEnv.authenticatedContext('staff-b').storage();
  await assertSucceeds(getBytes(ref(staffBStorage, 'manual-library/shared/manual.pdf')));
  await assertFails(getBytes(ref(staffBStorage, 'companies/company-a/evidence/protected.jpg')));
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

test('firestore: staff can read active quiz question in own company', async () => {
  await seedMembership({ uid: 'staff-quiz', companyId: 'company-quiz', role: 'staff' });
  const testEnv = await rulesTestEnvPromise;
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'quizQuestions', 'q1'), { companyId: 'company-quiz', prompt: 'Q', active: true });
  });
  const db = testEnv.authenticatedContext('staff-quiz').firestore();
  await assertSucceeds(getDoc(doc(db, 'quizQuestions', 'q1')));
});

test('firestore: manager can create update and archive quiz question; staff cannot write', async () => {
  await seedMembership({ uid: 'manager-quiz', companyId: 'company-quiz', role: 'manager' });
  await seedMembership({ uid: 'staff-quiz', companyId: 'company-quiz', role: 'staff' });
  const testEnv = await rulesTestEnvPromise;
  const managerDb = testEnv.authenticatedContext('manager-quiz').firestore();
  const staffDb = testEnv.authenticatedContext('staff-quiz').firestore();
  await assertSucceeds(setDoc(doc(managerDb, 'quizQuestions', 'q2'), { companyId: 'company-quiz', prompt: 'Q2', active: true }));
  await assertSucceeds(setDoc(doc(managerDb, 'quizQuestions', 'q2'), { companyId: 'company-quiz', active: false }, { merge: true }));
  await assertFails(setDoc(doc(staffDb, 'quizQuestions', 'q3'), { companyId: 'company-quiz', prompt: 'no' }));
  await assertFails(setDoc(doc(staffDb, 'quizQuestions', 'q2'), { companyId: 'company-quiz', prompt: 'edit' }, { merge: true }));
});

test('firestore: client cannot create quiz submissions and lead can read own-company submissions only', async () => {
  await seedMembership({ uid: 'lead-quiz', companyId: 'company-quiz', role: 'lead' });
  await seedMembership({ uid: 'staff-quiz', companyId: 'company-quiz', role: 'staff' });
  await seedMembership({ uid: 'lead-other', companyId: 'company-other', role: 'lead' });
  const testEnv = await rulesTestEnvPromise;
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'quizSubmissions', 's1'), { companyId: 'company-quiz', workerId: 'w1' });
  });
  const staffDb = testEnv.authenticatedContext('staff-quiz').firestore();
  const leadDb = testEnv.authenticatedContext('lead-quiz').firestore();
  const otherLeadDb = testEnv.authenticatedContext('lead-other').firestore();
  await assertFails(setDoc(doc(staffDb, 'quizSubmissions', 's2'), { companyId: 'company-quiz' }));
  await assertSucceeds(getDoc(doc(leadDb, 'quizSubmissions', 's1')));
  await assertFails(getDoc(doc(otherLeadDb, 'quizSubmissions', 's1')));
});
