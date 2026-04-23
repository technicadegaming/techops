#!/usr/bin/env node
const admin = require('firebase-admin');
const { assessManualLibraryRecordIntegrity } = require('../src/services/manualLibraryService');

function hasFlagArg(name) {
  return process.argv.includes(name);
}

async function main() {
  const apply = hasFlagArg('--apply');
  admin.initializeApp();
  const db = admin.firestore();
  const snap = await db.collection('manualLibrary').get();
  const rows = (snap.docs || []).map((doc) => ({ id: doc.id, ...doc.data() }));
  const suspicious = [];

  for (const row of rows) {
    const integrity = assessManualLibraryRecordIntegrity(row);
    if (!integrity.suspicious) continue;
    suspicious.push({
      id: row.id,
      approvalState: row.approvalState || '',
      approved: row.approved === true,
      canonicalTitle: row.canonicalTitle || '',
      familyTitle: row.familyTitle || '',
      manufacturer: row.manufacturer || '',
      sourceTitle: row.sourceTitle || row.title || '',
      sourceUrl: row.sourcePageUrl || row.originalDownloadUrl || row.resolvedDownloadUrl || '',
      matchType: row.matchType || '',
      flags: integrity.flags,
    });
    if (apply) {
      await db.collection('manualLibrary').doc(row.id).set({
        integrityFlagged: true,
        quarantined: true,
        integrityStatus: 'flagged',
        integrityFlags: integrity.flags,
        integrityFlaggedAt: new Date().toISOString(),
        integrityReviewSummary: integrity.reviewSummary,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    }
  }

  process.stdout.write(JSON.stringify({
    scanned: rows.length,
    suspiciousCount: suspicious.length,
    apply,
    suspicious,
  }, null, 2));
  process.stdout.write('\n');
}

main().catch((error) => {
  process.stderr.write(`manual-library integrity report failed: ${error.message}\n`);
  process.exitCode = 1;
});

