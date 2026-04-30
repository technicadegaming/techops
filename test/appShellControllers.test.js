const test = require('node:test');
const assert = require('node:assert/strict');

async function loadActionCenter() {
  return import('../src/app/actionCenter.js');
}

async function loadContextSwitcher() {
  return import('../src/app/contextSwitcher.js');
}

async function loadNavigationController() {
  return import('../src/app/navigationController.js');
}

async function loadAuthControllerHelpers() {
  return import('../src/app/authController.helpers.js');
}

async function loadViewVisibilityHelpers() {
  return import('../src/app/viewVisibility.js');
}

async function loadBootstrapErrors() {
  return import('../src/app/bootstrapErrors.js');
}

async function loadRuntimeCollections() {
  return import('../src/app/runtimeCollections.js');
}

async function loadAuthHandoffHelpers() {
  return import('../src/app/authHandoff.js');
}


async function loadMembershipCompatibilityHelpers() {
  return import('../src/app/membershipCompatibility.js');
}

async function loadDocumentationReviewHelpers() {
  return import('../src/features/documentationReview.js');
}

async function loadAssetEnrichmentPipeline() {
  return import('../src/features/assetEnrichmentPipeline.js');
}


async function loadAssetIntakeHelpers() {
  return import('../src/features/assetIntake.js');
}

async function loadAssetsHelpers() {
  return import('../src/features/assets.js');
}


async function loadOperationsHelpers() {
  return import('../src/features/operations.js');
}

async function loadAssetDraftContextHelpers() {
  return import('../src/features/assetDraftContext.js');
}


async function loadOnboardingView() {
  return import('../src/onboarding.js');
}

async function loadThemeHelpers() {
  return import('../src/app/theme.js');
}

async function loadStateHelpers() {
  return import('../src/app/state.js');
}

async function loadAssetActions() {
  return import('../src/features/assetActions.js');
}

async function loadAdminActions() {
  return import('../src/features/adminActions.js');
}

async function loadAccountController() {
  return import('../src/app/accountController.js');
}

async function loadManufacturerNormalizationHelpers() {
  return import('../src/features/manufacturerNormalization.js');
}

async function loadRolesHelpers() {
  return import('../src/roles.js');
}

function createSelectElement() {
  return {
    innerHTML: '',
    onchange: null,
    classList: {
      values: new Set(),
      add(value) { this.values.add(value); },
      remove(value) { this.values.delete(value); },
      contains(value) { return this.values.has(value); }
    }
  };
}

function createButtonElement(tabName) {
  return {
    dataset: { tab: tabName },
    listeners: {},
    classList: {
      toggled: [],
      toggle(name, active) { this.toggled.push({ name, active }); }
    },
    addEventListener(type, handler) {
      this.listeners[type] = handler;
    }
  };
}

function createSectionElement(id) {
  return {
    id,
    classList: {
      toggled: [],
      toggle(name, active) { this.toggled.push({ name, active }); }
    }
  };
}

test('onboarding view module loads without syntax errors', async () => {
  const onboarding = await loadOnboardingView();
  assert.equal(typeof onboarding.renderOnboarding, 'function');
});

test('operations role helpers gate staff create/run/save by settings', async () => {
  const { canCreateTasks, canRunAiTroubleshooting, canSaveFixToLibrary } = await loadRolesHelpers();
  const staff = { companyRole: 'staff' };
  const lead = { companyRole: 'lead' };

  assert.equal(canCreateTasks(staff), true);
  assert.equal(canRunAiTroubleshooting(staff, { aiAllowStaffManualRerun: false }), false);
  assert.equal(canRunAiTroubleshooting(staff, { aiAllowStaffManualRerun: true }), true);
  assert.equal(canSaveFixToLibrary(staff, { aiAllowStaffSaveFixesToLibrary: false }), false);
  assert.equal(canSaveFixToLibrary(staff, { aiAllowStaffSaveFixesToLibrary: true }), true);
  assert.equal(canRunAiTroubleshooting(lead, {}), true);
  assert.equal(canSaveFixToLibrary(lead, {}), true);
});


test('asset helpers prefer authoritative manual attachment fields over legacy searching state', async () => {
  const { getAuthoritativeManualState, getEffectiveEnrichmentStatus } = await loadAssetsHelpers();
  const attached = getAuthoritativeManualState({
    enrichmentStatus: 'searching_docs',
    manualLibraryRef: 'manual-quik-drop',
    manualStoragePath: 'manual-library/bay-tek/quik-drop/existing.pdf',
    manualLinks: [],
    documentationSuggestions: [],
  });
  assert.equal(attached.hasAttachedManual, true);
  assert.deepEqual(attached.manualLinks, ['manual-library/bay-tek/quik-drop/existing.pdf']);
  assert.equal(getEffectiveEnrichmentStatus(attached), 'verified_manual_found');

  const fallback = getAuthoritativeManualState({
    enrichmentStatus: 'searching_docs',
    manualLibraryRef: '',
    manualStoragePath: '',
    manualLinks: ['https://example.com/manual.pdf'],
  });
  assert.equal(fallback.hasAttachedManual, false);
  assert.deepEqual(fallback.manualLinks, []);
});

test('asset helpers prefer storage-backed attached manual links over external source URLs', async () => {
  const { getAuthoritativeManualState, resolveStoragePreferredManualLink } = await loadAssetsHelpers();
  const state = getAuthoritativeManualState({
    manualLibraryRef: 'manual-king-kong',
    manualStoragePath: 'manual-library/raw-thrills/king-kong/existing.pdf',
    manualLinks: [
      'https://rawthrills.com/wp-content/uploads/king-kong-manual.pdf',
      'manual-library/raw-thrills/king-kong/existing.pdf',
      'https://support.example.com/product-page'
    ],
  });
  assert.equal(state.hasAttachedManual, true);
  assert.deepEqual(state.manualLinks, ['manual-library/raw-thrills/king-kong/existing.pdf']);
  const preferred = resolveStoragePreferredManualLink({
    manualLibraryRef: 'manual-king-kong',
    manualStoragePath: 'manual-library/raw-thrills/king-kong/existing.pdf',
  }, 'file:///Users/me/Downloads/king-kong-manual.pdf');
  assert.equal(preferred.openedFromStoragePreferred, true);
  assert.equal(preferred.manualSourceUrlSuppressedBecauseStorageExists, true);
  assert.equal(preferred.storageMetadataPresentButExternalUsed, false);
  assert.equal(preferred.dataStoragePath, 'manual-library/raw-thrills/king-kong/existing.pdf');
  assert.equal(preferred.href, '#');
});

test('asset helpers render attached manual chips from durable storage metadata instead of local file URLs', async () => {
  const { getAuthoritativeManualState, resolveStoragePreferredManualLink } = await loadAssetsHelpers();
  const manualState = getAuthoritativeManualState({
    manualLibraryRef: 'manual-king-kong',
    manualStoragePath: 'manual-library/raw-thrills/king-kong/existing.pdf',
    manualLinks: [
      'file:///Users/me/Downloads/king-kong-manual.pdf',
      'https://rawthrills.com/manuals/king-kong.pdf',
      'manual-library/raw-thrills/king-kong/existing.pdf',
    ],
  });
  assert.deepEqual(manualState.manualLinks, ['manual-library/raw-thrills/king-kong/existing.pdf']);
  const preferred = resolveStoragePreferredManualLink({
    manualLibraryRef: manualState.manualLibraryRef,
    manualStoragePath: manualState.manualStoragePath,
    manualLinks: manualState.manualLinks,
  }, 'file:///Users/me/Downloads/king-kong-manual.pdf');
  assert.equal(preferred.dataStoragePath, 'manual-library/raw-thrills/king-kong/existing.pdf');
  assert.equal(preferred.href, '#');
});

test('asset helpers surface attached-manual status when durable metadata exists even if legacy follow-up state remains', async () => {
  const { deriveAssetManualStatus, getEffectiveEnrichmentStatus } = await loadAssetsHelpers();
  const hyperShoot = {
    name: 'HYPERshoot',
    enrichmentStatus: 'followup_needed',
    manualLibraryRef: 'manual-hypershoot',
    manualStoragePath: 'manual-library/moss/hypershoot/operator.pdf',
    supportResourcesSuggestion: [{ url: 'https://mossdistributing.com/support/hypershoot', label: 'Support' }],
  };
  assert.equal(deriveAssetManualStatus(hyperShoot), 'manual_attached');
  assert.equal(getEffectiveEnrichmentStatus(hyperShoot), 'verified_manual_found');
});

test('asset helpers keep external candidate link when durable storage metadata is missing', async () => {
  const { resolveStoragePreferredManualLink } = await loadAssetsHelpers();
  const externalUrl = 'https://example.com/manual.pdf';
  const preferred = resolveStoragePreferredManualLink({
    manualLibraryRef: '',
    manualStoragePath: '',
    manualLinks: [externalUrl],
  }, externalUrl);
  assert.equal(preferred.href, externalUrl);
  assert.equal(preferred.dataStoragePath, '');
  assert.equal(preferred.openedFromStoragePreferred, false);
  assert.equal(preferred.manualSourceUrlSuppressedBecauseStorageExists, false);
});

test('asset manual links do not render raw Firebase Storage REST URLs from storage paths', async () => {
  const { buildStoredManualDownloadUrl } = await loadAssetsHelpers();
  const storagePath = 'manual-library/bay-tek/quik-drop/existing.pdf';
  const resolved = buildStoredManualDownloadUrl(storagePath);
  assert.equal(resolved, '#');
  assert.equal(resolved.startsWith('https://wow.technicade.tech/manual-library/'), false);
  assert.equal(resolved.includes('/v0/b/'), false);
  assert.equal(resolved.includes('firebasestorage.googleapis.com'), false);
  const tenantPath = 'companies/company-a/manuals/asset-1/manual-1/source.pdf';
  const tenantResolved = buildStoredManualDownloadUrl(tenantPath);
  assert.equal(tenantResolved, '#');
});

test('asset manual links resolve stored manual paths through Firebase Storage getDownloadURL flow', async () => {
  const { resolveStoredManualDownloadUrl } = await loadAssetsHelpers();
  const storagePath = 'manual-library/bay-tek/quik-drop/existing.pdf';
  const storageInstance = { kind: 'storage' };
  const calls = [];
  const resolved = await resolveStoredManualDownloadUrl(storagePath, {
    storage: storageInstance,
    storageRef: (storageArg, pathArg) => {
      calls.push({ step: 'ref', storageArg, pathArg });
      return { storageArg, pathArg };
    },
    getDownloadURL: async (manualRef) => {
      calls.push({ step: 'download', manualRef });
      return `https://download.example/${encodeURIComponent(manualRef.pathArg)}`;
    }
  });
  assert.equal(resolved, 'https://download.example/manual-library%2Fbay-tek%2Fquik-drop%2Fexisting.pdf');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].step, 'ref');
  assert.equal(calls[0].storageArg, storageInstance);
  assert.equal(calls[0].pathArg, storagePath);
  assert.equal(calls[1].step, 'download');
  assert.equal(calls[1].manualRef.pathArg, storagePath);
  assert.equal(resolved.includes('/v0/b/'), false);
});

test('asset manual links open popup-safe placeholder before SDK URL resolution', async () => {
  const { openStoredManualPath } = await loadAssetsHelpers();
  const calls = [];
  const openedWindow = {
    opener: { active: true },
    location: {
      href: '',
      replace: (value) => {
        calls.push(`replace:${value}`);
        openedWindow.location.href = value;
      }
    },
    close: () => calls.push('close')
  };
  const originalWindow = global.window;
  const originalConsoleDebug = console.debug;
  try {
    console.debug = () => {};
    global.window = {
      open: (...args) => {
        calls.push(`open:${args[0]}:${args[1]}`);
        return openedWindow;
      }
    };
    await openStoredManualPath({
      dataset: { manualStoragePath: encodeURIComponent('manual-library/raw-thrills/king-kong/manual.pdf') },
      closest: () => null,
    }, {
      storageRuntime: {
        storage: { id: 'storage' },
        storageRef: () => {
          calls.push('storageRef');
          return { path: 'manual-library/raw-thrills/king-kong/manual.pdf' };
        },
        getDownloadURL: async () => {
          calls.push('getDownloadURL');
          return 'https://cdn.example/manual.pdf';
        },
      }
    });
    assert.deepEqual(calls.slice(0, 3), ['open::_blank', 'storageRef', 'getDownloadURL']);
    assert.equal(openedWindow.opener, null);
    assert.match(calls[3], /^replace:https:\/\/cdn\.example\/manual\.pdf$/);
    assert.equal(openedWindow.location.href, 'https://cdn.example/manual.pdf');
  } finally {
    console.debug = originalConsoleDebug;
    global.window = originalWindow;
  }
});

test('asset manual links show inline error feedback when SDK URL resolution fails', async () => {
  const { openStoredManualPath } = await loadAssetsHelpers();
  const originalWindow = global.window;
  const originalDocument = global.document;
  const feedbackHolder = {
    innerHTML: '',
    firstChild: null,
    querySelector: () => null,
    insertBefore(node) {
      this.innerHTML = node.innerHTML;
    }
  };
  const openedWindow = { closeCalled: false, close() { this.closeCalled = true; } };
  const originalConsoleDebug = console.debug;
  try {
    console.debug = () => {};
    global.window = {
      open: () => openedWindow
    };
    global.document = {
      createElement: () => ({ dataset: {}, innerHTML: '' })
    };
    await openStoredManualPath({
      dataset: { manualStoragePath: encodeURIComponent('manual-library/raw-thrills/king-kong/manual.pdf') },
      closest: () => feedbackHolder,
    }, {
      storageRuntime: {
        storage: { id: 'storage' },
        storageRef: () => ({ path: 'manual-library/raw-thrills/king-kong/manual.pdf' }),
        getDownloadURL: async () => { throw new Error('not found'); },
      }
    });
    assert.equal(openedWindow.closeCalled, true);
    assert.match(feedbackHolder.innerHTML, /Unable to open this manual right now/i);
  } finally {
    console.debug = originalConsoleDebug;
    global.window = originalWindow;
    global.document = originalDocument;
  }
});

test('asset manual links show inline feedback when placeholder window is blocked and do not open a dead tab', async () => {
  const { openStoredManualPath } = await loadAssetsHelpers();
  const originalWindow = global.window;
  const originalDocument = global.document;
  const originalConsoleDebug = console.debug;
  const feedbackHolder = {
    innerHTML: '',
    firstChild: null,
    querySelector: () => null,
    insertBefore(node) {
      this.innerHTML = node.innerHTML;
    }
  };
  const calls = [];
  try {
    console.debug = () => {};
    global.window = {
      open: (...args) => {
        calls.push(args);
        return null;
      }
    };
    global.document = {
      createElement: () => ({ dataset: {}, innerHTML: '' })
    };
    await openStoredManualPath({
      dataset: { manualStoragePath: encodeURIComponent('manual-library/raw-thrills/king-kong/manual.pdf') },
      closest: () => feedbackHolder,
    }, {
      storageRuntime: {
        storage: { id: 'storage' },
        storageRef: () => ({ path: 'manual-library/raw-thrills/king-kong/manual.pdf' }),
        getDownloadURL: async () => 'https://cdn.example/manual.pdf',
      }
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], ['', '_blank']);
    assert.match(feedbackHolder.innerHTML, /Popup was blocked before the manual was ready/i);
  } finally {
    console.debug = originalConsoleDebug;
    global.window = originalWindow;
    global.document = originalDocument;
  }
});

test('asset helpers downgrade stale in-progress runs without heartbeat to retry_needed', async () => {
  const { getEffectiveEnrichmentStatus } = await loadAssetsHelpers();
  const staleAsset = {
    enrichmentStatus: 'in_progress',
    enrichmentRequestedAt: new Date(Date.now() - (5 * 60 * 1000)).toISOString(),
    enrichmentHeartbeatAt: new Date(Date.now() - (4 * 60 * 1000)).toISOString(),
    supportResourcesSuggestion: [],
    manualLibraryRef: '',
    manualStoragePath: '',
    manualLinks: [],
  };
  assert.equal(getEffectiveEnrichmentStatus(staleAsset), 'retry_needed');
});

test('asset helpers treat stale running records with completed follow-up context as terminal followup_needed', async () => {
  const { getEffectiveEnrichmentStatus } = await loadAssetsHelpers();
  const staleAsset = {
    enrichmentStatus: 'in_progress',
    enrichmentRequestedAt: new Date(Date.now() - (5 * 60 * 1000)).toISOString(),
    enrichmentHeartbeatAt: new Date(Date.now() - (4 * 60 * 1000)).toISOString(),
    documentationSuggestions: [{ url: 'https://example.com/manual-source', title: 'Manual source' }],
    supportResourcesSuggestion: [{ url: 'https://example.com/support', label: 'Support' }],
    enrichmentFollowupQuestion: 'Confirm cabinet version?',
    manualLibraryRef: '',
    manualStoragePath: '',
    manualLinks: [],
  };
  assert.equal(getEffectiveEnrichmentStatus(staleAsset), 'followup_needed');
});

test('asset helpers treat terminal manual outcomes as not-running even when legacy enrichmentStatus is stale', async () => {
  const { getEffectiveEnrichmentStatus } = await loadAssetsHelpers();
  assert.equal(getEffectiveEnrichmentStatus({
    manualStatus: 'support_only',
    enrichmentStatus: 'in_progress',
    supportResourcesSuggestion: [{ url: 'https://example.com/support', label: 'Support' }],
    enrichmentRequestedAt: new Date(Date.now() - (5 * 60 * 1000)).toISOString(),
    enrichmentHeartbeatAt: new Date(Date.now() - (4 * 60 * 1000)).toISOString(),
  }), 'followup_needed');
  assert.equal(getEffectiveEnrichmentStatus({
    manualStatus: 'review_needed',
    enrichmentStatus: 'searching_docs',
    documentationSuggestions: [{ url: 'https://example.com/manual.pdf', verified: true, exactTitleMatch: true, exactManualMatch: true }],
    enrichmentRequestedAt: new Date(Date.now() - (5 * 60 * 1000)).toISOString(),
    enrichmentHeartbeatAt: new Date(Date.now() - (4 * 60 * 1000)).toISOString(),
  }), 'followup_needed');
  assert.equal(getEffectiveEnrichmentStatus({
    manualStatus: 'no_public_manual',
    enrichmentStatus: 'in_progress',
    enrichmentRequestedAt: new Date(Date.now() - (5 * 60 * 1000)).toISOString(),
    enrichmentHeartbeatAt: new Date(Date.now() - (4 * 60 * 1000)).toISOString(),
  }), 'no_match_yet');
});

test('asset helpers keep non-reviewable documentation candidates visible for follow-up messaging', async () => {
  const { getDocumentationSuggestionBuckets } = await loadAssetsHelpers();
  const buckets = getDocumentationSuggestionBuckets({
    documentationSuggestions: [
      {
        title: 'Strong manual',
        url: 'https://example.com/manual.pdf',
        verified: true,
        exactTitleMatch: true,
        exactManualMatch: true,
        trustedSource: true
      },
      {
        title: 'Needs follow-up',
        url: 'https://example.com/product-page',
        verified: false,
        exactTitleMatch: true,
        exactManualMatch: false
      },
      {
        title: 'Dead page',
        url: 'https://example.com/dead',
        deadPage: true
      }
    ]
  });
  assert.equal(buckets.reviewable.length, 1);
  assert.equal(buckets.followupCandidates.length, 1);
  assert.equal(buckets.allCandidates.length, 2);
});

test('manufacturer normalization canonicalizes Bay Tek aliases for display and apply actions', async () => {
  const { normalizeManufacturerDisplayName } = await loadManufacturerNormalizationHelpers();
  assert.equal(normalizeManufacturerDisplayName('baytek'), 'Bay Tek');
  assert.equal(normalizeManufacturerDisplayName('baytek ent'), 'Bay Tek');
  assert.equal(normalizeManufacturerDisplayName('Raw Thrills'), 'Raw Thrills');
});

test('bootstrap error helper surfaces blocked membership lookup permission step', async () => {
  const { buildBootstrapErrorMessage } = await loadBootstrapErrors();
  const message = buildBootstrapErrorMessage({
    code: 'permission-denied',
    message: 'Missing or insufficient permissions',
    bootstrapStep: 'membership_lookup'
  });
  assert.match(message, /membership lookup/);
  assert.match(message, /blocked by Firestore permissions/);
});

test('bootstrap error helper preserves non-permission fallback formatting', async () => {
  const { buildBootstrapErrorMessage } = await loadBootstrapErrors();
  assert.equal(
    buildBootstrapErrorMessage(new Error('Network timeout while loading workspace context.')),
    'Unable to finish account setup. Network timeout while loading workspace context.'
  );
});

test('runtime collections mapping accepts workspace aliases for company bootstrap paths', async () => {
  const { normalizeCollections } = await loadRuntimeCollections();
  const mapped = normalizeCollections(
    { companies: 'companies', companyMemberships: 'companyMemberships', users: 'users' },
    { workspaces: 'workspaces', workspace_members: 'workspace_members' }
  );
  assert.equal(mapped.companies, 'workspaces');
  assert.equal(mapped.companyMemberships, 'workspace_members');
  assert.equal(mapped.users, 'users');
});

test('runtime collections mapping keeps explicit canonical overrides ahead of aliases', async () => {
  const { normalizeCollections } = await loadRuntimeCollections();
  const mapped = normalizeCollections(
    { companies: 'companies', companyMemberships: 'companyMemberships' },
    { companies: 'companies_v2', workspaces: 'workspaces', workspace_members: 'workspace_members' }
  );
  assert.equal(mapped.companies, 'companies_v2');
  assert.equal(mapped.companyMemberships, 'workspace_members');
});


test('membership compatibility normalizes canonical membership records', async () => {
  const { normalizeMembershipRecords } = await loadMembershipCompatibilityHelpers();
  const rows = normalizeMembershipRecords([
    { id: 'co-1_u-1', companyId: 'co-1', userId: 'u-1', role: 'owner', status: 'active' }
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].companyId, 'co-1');
  assert.equal(rows[0].userId, 'u-1');
  assert.equal(rows[0].role, 'owner');
  assert.equal(rows[0].status, 'active');
});

test('membership compatibility normalizes legacy workspace_members fields into canonical shape', async () => {
  const { normalizeMembershipRecords } = await loadMembershipCompatibilityHelpers();
  const rows = normalizeMembershipRecords([
    { id: 'legacy-1', workspaceId: 'ws-1', uid: 'u-1', workspaceRole: 'manager', isActive: true },
    { id: 'legacy-2', workspaceId: 'ws-1', uid: 'u-1', status: 'inactive' }
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].companyId, 'ws-1');
  assert.equal(rows[0].userId, 'u-1');
  assert.equal(rows[0].role, 'manager');
  assert.equal(rows[0].status, 'active');
});

test('auth handoff fallback engages only for membership lookup permission denial and preserves onboarding path', async () => {
  const { canFallbackToOnboarding, buildOnboardingFallbackState } = await loadAuthHandoffHelpers();
  assert.equal(canFallbackToOnboarding({ code: 'permission-denied', bootstrapStep: 'membership_lookup' }), true);
  assert.equal(canFallbackToOnboarding({ code: 'permission-denied', bootstrapStep: 'legacy_workspace_auto_adopt' }), false);

  const state = {
    company: { id: 'co-1' },
    memberships: [{ id: 'co-1_u-1' }],
    membershipCompanies: { 'co-1_u-1': { id: 'co-1' } },
    activeMembership: { id: 'co-1_u-1' },
    onboardingRequired: false
  };
  const fallback = buildOnboardingFallbackState(state);
  assert.equal(fallback.onboardingRequired, true);
  assert.equal(fallback.company, null);
  assert.deepEqual(fallback.memberships, []);
  assert.deepEqual(fallback.membershipCompanies, {});
  assert.equal(fallback.activeMembership, null);
});

test('admin people source includes active tab affordance and unified worker/access controls', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'admin.js'), 'utf8');
  assert.match(source, /aria-current="\$\{section\.id === activeSection \? 'page' : 'false'\}"/);
  assert.match(source, /Invite status:/);
  assert.match(source, /data-toggle-worker-profile/);
  assert.match(source, /buildPeopleRows/);
  assert.match(source, /App access controls who can sign in\. Worker profile controls who can be assigned to tasks\./);
});

test('applyActionCenterFocus translates dashboard focus into operations filters and route flags', async () => {
  const { applyActionCenterFocus, applyShellFocus } = await loadActionCenter();

  const state = { operationsUi: { statusFilter: 'all' }, route: { tab: 'dashboard' } };
  const blockedResult = applyActionCenterFocus(state, 'blocked');
  assert.deepEqual(blockedResult, { routeChanged: false });
  assert.equal(state.operationsUi.statusFilter, 'open');
  assert.equal(state.operationsUi.exceptionFilter, 'blocked');

  const pmResult = applyActionCenterFocus(state, 'overdue_pm');
  assert.deepEqual(pmResult, { routeChanged: true });
  assert.equal(state.route.pmFilter, 'overdue');

  let adminSection = '';
  const shellResult = applyShellFocus(state, 'pending_invites', {
    setAdminSection(value) {
      adminSection = value;
    }
  });
  assert.deepEqual(shellResult, { routeChanged: false });
  assert.equal(adminSection, 'people');

  const assetRouteResult = applyShellFocus(state, 'missing_docs');
  assert.deepEqual(assetRouteResult, { routeChanged: true });
  assert.equal(state.route.assetFilter, 'missing_docs');
});

test('asset intake row mapping reuses manual engine summary shape for bulk and single-entry previews', async () => {
  const { mapPreviewToAssetIntakeRow } = await loadAssetIntakeHelpers();
  const preview = {
    confidence: 0.91,
    likelyManufacturer: 'Bay Tek',
    likelyCategory: 'Redemption',
    manualMatchSummary: {
      inputTitle: 'Quick Drop',
      assetNameOriginal: 'Quick Drop',
      assetNameNormalized: 'Quik Drop',
      canonicalTitle: 'Quik Drop',
      manufacturer: 'Bay Tek',
      manufacturerInferred: true,
      matchType: 'exact_manual',
      manualReady: true,
      confidence: 0.91,
      matchNotes: 'matchType: exact_manual | normalized from: Quick Drop | manufacturer: Bay Tek',
      manualUrl: 'https://www.betson.com/wp-content/uploads/2018/03/quik-drop-service-manual.pdf',
      manualSourceUrl: 'https://www.baytekent.com/games/quik-drop/',
      supportEmail: 'support@baytekent.com',
      supportPhone: '5555555555',
      supportUrl: 'https://www.baytekent.com/games/quik-drop/',
      alternateTitles: ['Quik Drop', 'Quick Drop'],
      variantWarning: '',
      reviewRequired: false
    }
  };

  const row = mapPreviewToAssetIntakeRow({ name: 'Quick Drop', manufacturer: '' }, preview);
  assert.equal(row.originalTitle, 'Quick Drop');
  assert.equal(row.normalizedTitle, 'Quik Drop');
  assert.equal(row.normalizedName, 'Quik Drop');
  assert.equal(row.manufacturer, 'Bay Tek');
  assert.equal(row.manufacturerInferred, true);
  assert.equal(row.manualHintUrl, 'https://www.betson.com/wp-content/uploads/2018/03/quik-drop-service-manual.pdf');
  assert.equal(row.manualSourceHintUrl, 'https://www.baytekent.com/games/quik-drop/');
  assert.equal(row.supportHintUrl, 'https://www.baytekent.com/games/quik-drop/');
  assert.equal(row.matchType, 'exact_manual');
  assert.equal(row.manualReady, true);
  assert.equal(row.reviewNeeded, false);
});



test('asset intake row mapping keeps source-only matches review-required in bulk the same way as single-entry previews', async () => {
  const { mapPreviewToAssetIntakeRow } = await loadAssetIntakeHelpers();
  const preview = {
    confidence: 0.74,
    likelyManufacturer: 'Raw Thrills',
    manualMatchSummary: {
      inputTitle: 'Jurassic Park',
      assetNameOriginal: 'Jurassic Park',
      assetNameNormalized: 'Jurassic Park Arcade',
      canonicalTitle: 'Jurassic Park Arcade',
      manufacturer: 'Raw Thrills',
      matchType: 'support_only',
      manualReady: false,
      confidence: 0.74,
      matchNotes: 'matchType: support_only | manufacturer: Raw Thrills',
      manualUrl: '',
      manualSourceUrl: '',
      supportUrl: 'https://rawthrills.com/service/',
      variantWarning: '',
      reviewRequired: true
    }
  };

  const row = mapPreviewToAssetIntakeRow({ name: 'Jurassic Park', manufacturer: '' }, preview);
  assert.equal(row.matchType, 'support_only');
  assert.equal(row.manualReady, false);
  assert.equal(row.reviewRequired, true);
  assert.equal(row.rowStatus, 'needs_review');
  assert.equal(row.supportHintUrl, 'https://rawthrills.com/service/');
  assert.equal(row.manualHintUrl, '');
});

test('context switcher renders derived location options and syncs route changes', async () => {
  const { createContextSwitcherController } = await loadContextSwitcher();
  const activeLocationSwitcher = createSelectElement();
  const locationScopeBadge = { textContent: '' };
  const pushes = [];
  let renderCount = 0;
  const state = {
    route: { locationKey: 'loc-1' },
    companyLocations: [{ id: 'loc-1', name: 'Arcade Floor' }],
    assets: [{ id: 'asset-1', locationName: 'Prize Counter' }],
    tasks: [],
    workers: []
  };

  const controller = createContextSwitcherController({
    state,
    elements: { activeLocationSwitcher, locationScopeBadge },
    setActiveMembership: async () => {},
    pushRouteState(route) { pushes.push({ ...route }); },
    render() { renderCount += 1; },
    runAction: async () => {},
    documentRef: { getElementById: () => null }
  });

  controller.renderActiveLocationSwitcher();
  assert.match(activeLocationSwitcher.innerHTML, /Company-wide/);
  assert.match(activeLocationSwitcher.innerHTML, /Arcade Floor/);
  assert.match(activeLocationSwitcher.innerHTML, /Prize Counter \(from records\)/);
  assert.equal(locationScopeBadge.textContent, 'Arcade Floor view');

  activeLocationSwitcher.onchange({ target: { value: 'derived-prize-counter' } });
  assert.equal(state.route.locationKey, 'derived-prize-counter');
  assert.deepEqual(pushes, [{ locationKey: 'derived-prize-counter' }]);
  assert.equal(renderCount, 1);
});

test('context switcher hides single-company selector and runs workspace switch through runAction', async () => {
  const { createContextSwitcherController } = await loadContextSwitcher();
  const activeCompanySwitcher = createSelectElement();
  const actions = [];
  const switched = [];
  const state = {
    memberships: [{ id: 'm-1', companyId: 'c-1', role: 'owner' }],
    activeMembership: { id: 'm-1' },
    membershipCompanies: { 'm-1': { name: 'Scoot Business' } },
    onboardingRequired: false,
    permissions: {},
    profile: {},
    user: { email: 'owner@example.com' },
    company: { name: 'Scoot Business' }
  };

  const controller = createContextSwitcherController({
    state,
    elements: { activeCompanySwitcher },
    setActiveMembership: async (id) => switched.push(id),
    pushRouteState: () => {},
    render: () => {},
    runAction: async (label, work, options) => {
      actions.push({ label, options });
      await work();
    },
    documentRef: { getElementById: () => ({ textContent: '' }) }
  });

  controller.renderActiveCompanySwitcher();
  assert.equal(activeCompanySwitcher.classList.contains('hide'), true);
  assert.equal(activeCompanySwitcher.innerHTML, '');

  state.memberships.push({ id: 'm-2', companyId: 'c-2', role: 'manager' });
  state.membershipCompanies['m-2'] = { name: 'Second Arcade' };
  controller.renderActiveCompanySwitcher();
  assert.equal(activeCompanySwitcher.classList.contains('hide'), false);
  assert.match(activeCompanySwitcher.innerHTML, /Scoot Business \(owner\)/);
  assert.match(activeCompanySwitcher.innerHTML, /Second Arcade \(manager\)/);

  await activeCompanySwitcher.onchange({ target: { value: 'm-2' } });
  assert.deepEqual(switched, ['m-2']);
  assert.equal(actions[0].label, 'switch_company');
  assert.equal(actions[0].options.fallbackMessage, 'Unable to switch company workspace.');
});

test('navigation controller updates route, delegates focus pushes, and syncs admin/tools navigation', async () => {
  const { createNavigationController } = await loadNavigationController();
  const tabs = [createButtonElement('dashboard'), createButtonElement('admin')];
  const sections = [createSectionElement('dashboard'), createSectionElement('admin')];
  const tabsContainer = {
    innerHTML: '',
    querySelectorAll(selector) {
      return selector === '[data-tab]' ? tabs : [];
    }
  };
  const documentRef = {
    getElementById(id) {
      if (id === 'tabs') return tabsContainer;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '.tab') return tabs;
      if (selector === '.section') return sections;
      return [];
    }
  };

  global.window = {
    location: { search: '?tab=dashboard&taskId=t-1', pathname: '/app', hash: '' }
  };
  global.history = {
    pushes: [],
    pushState(_state, _title, url) {
      this.pushes.push(url);
      const query = url.split('?')[1] || '';
      global.window.location.search = query ? `?${query}` : '';
    }
  };

  const state = { route: { tab: 'dashboard', locationKey: null }, adminSection: 'overview' };
  const focusCalls = [];
  const controller = createNavigationController({
    state,
    sections: ['dashboard', 'admin'],
    canViewAdminTab: () => true,
    applyShellFocus(focus, options) {
      focusCalls.push({ focus, options: Object.keys(options || {}) });
      if (focus === 'missing_docs') {
        state.route = { ...state.route, assetFilter: 'missing_docs' };
        return { routeChanged: true };
      }
      return { routeChanged: false };
    },
    documentRef
  });

  controller.renderTabs();
  assert.match(tabsContainer.innerHTML, /data-tab="dashboard"/);
  assert.match(tabsContainer.innerHTML, /data-tab="admin"/);

  const nextRoute = controller.updateRoute({ locationKey: 'loc-2', tab: 'operations' });
  assert.deepEqual(nextRoute, { tab: 'operations', locationKey: 'loc-2' });
  assert.equal(global.history.pushes.at(-1), '/app?tab=operations&taskId=t-1&locationKey=loc-2');

  const focusResult = controller.applyShellFocusAndPush('missing_docs');
  assert.deepEqual(focusResult, { routeChanged: true });
  assert.equal(state.route.assetFilter, 'missing_docs');
  assert.equal(global.history.pushes.at(-1), '/app?tab=operations&taskId=t-1&locationKey=loc-2&assetFilter=missing_docs');
  assert.deepEqual(focusCalls[0], { focus: 'missing_docs', options: ['setAdminSection'] });

  controller.openAdminTools();
  assert.equal(state.adminSection, 'tools');
  assert.equal(state.route.tab, 'admin');

  controller.syncFromUrl();
  assert.equal(state.route.tab, 'admin');
  assert.equal(state.route.taskId, 't-1');
});

test('auth controller password helpers report unmet requirements and confirm-state text', async () => {
  const { evaluatePassword, buildRegisterPasswordHelpText } = await loadAuthControllerHelpers();

  assert.deepEqual(evaluatePassword('Short1').checks.map((check) => check.ok), [false, true, true, true]);
  assert.equal(evaluatePassword('Short1').message, 'at least 8 characters');

  assert.equal(
    buildRegisterPasswordHelpText('ValidPass1', 'ValidPass1'),
    'ok at least 8 characters | ok one uppercase letter | ok one lowercase letter | ok one number | passwords match'
  );

  assert.equal(
    buildRegisterPasswordHelpText('lowercase', 'different'),
    'ok at least 8 characters | missing one uppercase letter | ok one lowercase letter | missing one number | passwords do not match'
  );
});

test('auth invite code UI wires explicit join button and Enter-key handling', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const authControllerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'authController.js'), 'utf8');

  assert.match(indexSource, /id="authInviteForm"/);
  assert.match(indexSource, /id="applyInviteCodeBtn"/);
  assert.match(indexSource, /Create or sign into your account first/);
  assert.match(indexSource, /Have an invite code\? Create or sign into your account first\. Then enter the code to join your workspace\./);
  assert.doesNotMatch(indexSource, /Bootstrap admin access is off by default/);
  assert.match(indexSource, /Join with invite/);
  assert.match(authControllerSource, /authInviteForm\?\.addEventListener\('submit', handleInviteCodeSubmit\)/);
  assert.match(authControllerSource, /authInviteCodeInput\?\.addEventListener\('keydown'/);
  assert.match(authControllerSource, /if \(event\.key !== 'Enter'\) return;/);
  assert.match(authControllerSource, /await applyInviteCode\(inviteCode\)/);
});

test('auth handoff keeps pending invite code for onboarding and does not auto-accept before membership exists', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');

  assert.match(appSource, /setOnboardingFeedback\(state, '', 'info', \{ pendingAction: '', handoffStatus: 'working' \}\);/);
  assert.match(appSource, /await bootstrapCompanyContext\(\);/);
  assert.doesNotMatch(appSource, /\[watchAuth\] Pending invite acceptance failed during sign-in handoff\./);
  assert.doesNotMatch(appSource, /await acceptCompanyInvite\(\{ inviteCode: pendingInviteCode, user: state\.user \}\)/);
});

test('root visibility helper keeps auth and app shell mutually exclusive', async () => {
  const { setRootViewVisibility, setAppChromeVisibility } = await loadViewVisibilityHelpers();
  const authView = {
    classList: {
      calls: [],
      toggle(name, active) { this.calls.push({ name, active }); }
    }
  };
  const appView = {
    classList: {
      calls: [],
      toggle(name, active) { this.calls.push({ name, active }); }
    }
  };

  setRootViewVisibility({ authView, appView, showAuth: true });
  assert.deepEqual(authView.classList.calls[0], { name: 'hide', active: false });
  assert.deepEqual(appView.classList.calls[0], { name: 'hide', active: true });

  setRootViewVisibility({ authView, appView, showAuth: false });
  assert.deepEqual(authView.classList.calls[1], { name: 'hide', active: true });
  assert.deepEqual(appView.classList.calls[1], { name: 'hide', active: false });

  const toggled = [];
  const makeEl = () => ({
    classList: {
      toggle(name, active) { toggled.push({ name, active }); },
      add(name) { toggled.push({ name, active: true, via: 'add' }); }
    }
  });
  setAppChromeVisibility({
    headerEl: makeEl(),
    tabsEl: makeEl(),
    companySwitcherEl: makeEl(),
    locationSwitcherEl: makeEl(),
    locationScopeBadgeEl: makeEl(),
    notificationBellEl: makeEl(),
    notificationPanelEl: makeEl(),
    logoutButtonEl: makeEl(),
    companyLogoEl: makeEl(),
    showChrome: false
  });
  assert.ok(toggled.some((entry) => entry.name === 'hide' && entry.active === true));
});

test('signed-in invite acceptance path refreshes membership state and routes into app shell', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');

  assert.match(appSource, /applyInviteCode: async \(inviteCode\) => \{/);
  assert.match(appSource, /await acceptCompanyInvite\(\{ inviteCode, user: state\.user \}\)/);
  assert.match(appSource, /await bootstrapCompanyContext\(\)/);
  assert.match(appSource, /await refreshData\(\)/);
  assert.match(appSource, /await render\(\)/);
  assert.match(appSource, /setRootViewVisibility\(\{ authView, appView, showAuth: false \}\)/);
  assert.match(appSource, /setAppChromeVisibility\(\{/);
  assert.match(appSource, /const showAppChrome = !state\.onboardingRequired && !state\.setupWizard\?\.active && hasActiveMembership;/);
});

test('join workspace onboarding keeps invite code on errors and does not continue to company creation flow', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const onboardingControllerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'onboardingController.js'), 'utf8');
  assert.match(onboardingControllerSource, /inviteCodePrefill: normalizedInviteCode/);
  assert.match(onboardingControllerSource, /await acceptInvite\(\{ inviteCode: normalizedInviteCode, user: state\.user \}\)/);
  assert.match(onboardingControllerSource, /state\.onboardingUi = \{ \.\.\.\(state\.onboardingUi \|\| \{\}\), inviteCodePrefill: '' \};/);
});

test('company invite acceptance uses callable handoff path for membership-safe joins', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const companySource = fs.readFileSync(path.join(__dirname, '..', 'src', 'company.js'), 'utf8');
  assert.match(companySource, /httpsCallable\(functions, 'acceptCompanyInvite'\)/);
  assert.match(companySource, /httpsCallable\(functions, 'createCompanyInvite'\)/);
  assert.doesNotMatch(companySource, /await updateDoc\(doc\(db, C\.companyInvites, invite\.id\), \{/);
  assert.doesNotMatch(companySource, /await setDoc\(ref, \{/);
});

test('asset and admin enrichment surfaces share the same manual trigger request and approval helper', async () => {
  const {
    approveSuggestedManualSources,
    buildFollowupEnrichmentRequest,
    buildFollowupRetryWithoutAnswerRequest,
    buildManualEnrichmentRequest
  } = await loadAssetEnrichmentPipeline();

  assert.deepEqual(buildManualEnrichmentRequest(), { trigger: 'manual' });
  assert.deepEqual(buildFollowupEnrichmentRequest('  exact subtitle  '), {
    trigger: 'followup_answer',
    followupAnswer: 'exact subtitle'
  });
  assert.deepEqual(buildFollowupRetryWithoutAnswerRequest(), {
    trigger: 'followup_retry_without_answer'
  });

  const approvalCalls = [];
  const approvalResult = await approveSuggestedManualSources({
    assetId: 'asset-1',
    urls: ['https://example.com/manual.pdf', 'https://example.com/manual.pdf'],
    current: { name: 'Quik Drop' },
    metadataByUrl: {
      'https://example.com/manual.pdf': {
        title: 'Quik Drop Service Manual',
        sourceType: 'distributor',
        index: 0
      }
    },
    approveAssetManual: async (payload) => {
      approvalCalls.push(payload);
    }
  });

  assert.deepEqual(approvalResult, { completed: 1, failed: 0 });
  assert.deepEqual(approvalCalls, [{
    assetId: 'asset-1',
    sourceUrl: 'https://example.com/manual.pdf',
    sourceTitle: 'Quik Drop Service Manual',
    sourceType: 'distributor',
    approvedSuggestionIndex: 0
  }]);
});


test('documentation review helpers keep support-only links out of approval while sharing the same patch rules', async () => {
  const {
    getReviewableDocumentationSuggestions,
    buildDocumentationApprovalSelection,
    buildDocumentationApprovalPatch
  } = await loadDocumentationReviewHelpers();

  const asset = {
    manualLinks: [],
    documentationSuggestions: [
      {
        title: 'Raw Thrills Service Support',
        url: 'https://rawthrills.com/service-support/',
        sourceType: 'support',
        verified: true,
        exactTitleMatch: false,
        exactManualMatch: false,
        trustedSource: true,
        verificationKind: 'support_html',
        matchType: 'support_only'
      },
      {
        title: 'Quik Drop Service Manual PDF',
        url: 'https://www.betson.com/wp-content/uploads/2018/03/quik-drop-service-manual.pdf',
        sourceType: 'distributor',
        verified: true,
        exactTitleMatch: true,
        exactManualMatch: true,
        trustedSource: true,
        matchScore: 96,
        matchType: 'exact_manual'
      },
      {
        title: 'Virtual Rabbids: The Big Ride Install Guide PDF',
        url: 'https://laigames.com/downloads/virtual-rabbids-the-big-ride-install-guide.pdf',
        sourceType: 'manufacturer',
        verified: true,
        exactTitleMatch: true,
        exactManualMatch: true,
        trustedSource: true,
        matchScore: 92,
        matchType: 'exact_manual'
      }
    ]
  };

  const reviewable = getReviewableDocumentationSuggestions(asset);
  assert.deepEqual(reviewable.map((entry) => entry.url), [
    'https://www.betson.com/wp-content/uploads/2018/03/quik-drop-service-manual.pdf',
    'https://laigames.com/downloads/virtual-rabbids-the-big-ride-install-guide.pdf'
  ]);

  const topTrusted = buildDocumentationApprovalSelection(asset, { mode: 'top_trusted' });
  const singlePatch = buildDocumentationApprovalPatch(asset, [topTrusted[0]], { reviewAction: 'approve_single' });
  const bulkPatch = buildDocumentationApprovalPatch(asset, topTrusted, { reviewAction: 'bulk_approve' });

  assert.deepEqual(topTrusted.map((entry) => entry.url), reviewable.map((entry) => entry.url));
  assert.equal(singlePatch.reviewState, 'approved');
  assert.equal(bulkPatch.reviewState, 'approved');
  assert.deepEqual(singlePatch.reviewApprovedSuggestionUrls, ['https://www.betson.com/wp-content/uploads/2018/03/quik-drop-service-manual.pdf']);
  assert.deepEqual(bulkPatch.reviewApprovedSuggestionUrls, reviewable.map((entry) => entry.url));
  assert.equal(singlePatch.enrichmentStatus, undefined);
  assert.equal(bulkPatch.manualStatus, undefined);
});




test('documentation review helpers reject support-only approvals', async () => {
  const { buildDocumentationApprovalPatch } = await loadDocumentationReviewHelpers();
  const asset = {
    manualLinks: [],
    documentationSuggestions: [{
      title: 'Raw Thrills Service Support',
      url: 'https://rawthrills.com/service-support/',
      sourceType: 'support',
      verified: true,
      exactTitleMatch: true,
      exactManualMatch: false,
      trustedSource: true,
      verificationKind: 'support_html',
      matchType: 'support_only'
    }]
  };

  assert.equal(buildDocumentationApprovalPatch(asset, asset.documentationSuggestions, { reviewAction: 'approve_single' }), null);
});

test('title bulk parser accepts comma-separated and newline input while deduplicating obvious duplicates', async () => {
  const { parseTitleBulkInput } = await loadAssetIntakeHelpers();
  const { rows, errors } = parseTitleBulkInput(`Quick Drop, Jurassic Park
Quick Drop
Air FX`);
  assert.deepEqual(errors, []);
  assert.deepEqual(rows.map((row) => row.name), ['Quick Drop', 'Jurassic Park', 'Air FX']);
});

test('asset csv parser remains backward compatible and maps legacy enrichment columns as hints', async () => {
  const { parseAssetCsv } = await loadAssetIntakeHelpers();
  const legacy = parseAssetCsv(`asset name,manufacturer,location
Quick Drop,Bay Tek Games,Main Floor`);
  assert.equal(legacy.errors.length, 0);
  assert.equal(legacy.rows[0].name, 'Quick Drop');
  assert.equal(legacy.rows[0].locationName, 'Main Floor');

  const enriched = parseAssetCsv(`asset name,assetId,manufacturer,originalTitle,normalizedTitle,manufacturerInferred,manualUrl,manualSourceUrl,supportEmail,supportPhone,supportUrl,matchType,manualReady,reviewRequired,matchConfidence,matchNotes
Jurassic Park,jp-01,Raw Thrills,Jurassic Park,Jurassic Park Arcade,false,https://manual.example/jp.pdf,https://source.example/jp,support@example.com,555-1111,https://support.example/jp,exact_manual,true,false,0.91,Official page`);
  assert.equal(enriched.errors.length, 0);
  assert.equal(enriched.rows[0].assetId, 'jp-01');
  assert.equal(enriched.rows[0].originalTitle, 'Jurassic Park');
  assert.equal(enriched.rows[0].normalizedTitle, 'Jurassic Park Arcade');
  assert.equal(enriched.rows[0].manufacturerInferred, 'false');
  assert.equal(enriched.rows[0].manualHintUrl, 'https://manual.example/jp.pdf');
  assert.equal(enriched.rows[0].manualSourceHintUrl, 'https://source.example/jp');
  assert.equal(enriched.rows[0].supportHintUrl, 'https://support.example/jp');
  assert.equal(enriched.rows[0].supportEmail, 'support@example.com');
  assert.equal(enriched.rows[0].matchType, 'exact_manual');
  assert.equal(enriched.rows[0].manualReady, 'true');
  assert.equal(enriched.rows[0].reviewRequired, 'false');
  assert.equal(enriched.rows[0].matchConfidence, '0.91');
});

test('shared intake enrichment helper powers single and bulk row enrichment mapping', async () => {
  const { enrichAssetIntakeRows, buildAssetCsv } = await loadAssetIntakeHelpers();
  const calls = [];
  const rows = await enrichAssetIntakeRows([{ name: 'Quick Drop' }, { name: 'Air FX' }], {
    lookup: async (payload) => {
      calls.push(payload.assetName);
      return {
        status: 'strong_match',
        normalizedName: payload.assetName,
        likelyManufacturer: payload.assetName === 'Quick Drop' ? 'Bay Tek Games' : 'Namco',
        confidence: 0.88,
        assetResearchSummary: {
          assetNameOriginal: payload.assetName,
          assetNameNormalized: payload.assetName,
          manufacturer: payload.assetName === 'Quick Drop' ? 'Bay Tek Games' : 'Namco',
          manufacturerInferred: true,
          matchType: 'exact_manual',
          manualReady: true,
          manualUrl: `https://manuals.example/${payload.assetName.toLowerCase().replace(/\s+/g, '-')}.pdf`,
          manualSourceUrl: 'https://source.example/manual',
          supportEmail: 'support@example.com',
          supportUrl: 'https://support.example/resource',
          reviewRequired: false,
          confidence: 0.88,
          status: 'docs_found'
        },
        documentationSuggestions: [{ url: `https://manuals.example/${payload.assetName.toLowerCase().replace(/\s+/g, '-')}.pdf`, sourceUrl: 'https://source.example/manual', sourceType: 'official' }],
        supportResourcesSuggestion: [{ url: 'https://support.example/resource', sourceType: 'support' }],
        supportContactsSuggestion: [{ contactType: 'email', value: 'support@example.com' }]
      };
    }
  });
  assert.deepEqual(calls, ['Quick Drop', 'Air FX']);
  assert.equal(rows[0].manufacturer, 'Bay Tek Games');
  assert.equal(rows[0].manualHintUrl, 'https://manuals.example/quick-drop.pdf');
  assert.equal(rows[0].supportEmail, 'support@example.com');
  assert.match(buildAssetCsv(rows), /asset name,assetId,manufacturer,model,serial,location,zone,category,status,notes,alternateNames,subtitleOrVersion,playerCount,cabinetType,vendorOrDistributor,manualHintUrl,manualSourceHintUrl,supportHintUrl,manufacturerWebsite,externalAssetKey/);
});

async function loadOnboardingStatusHelpers() {
  return import('../src/features/onboardingStatus.js');
}

function loadAppShellSource() {
  return require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'app.js'), 'utf8');
}

function loadAdminSource() {
  return require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'admin.js'), 'utf8');
}

function loadOperationsSource() {
  return require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'features', 'operations.js'), 'utf8');
}

function loadAssetsSource() {
  return require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'features', 'assets.js'), 'utf8');
}

function loadDataSource() {
  return require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'data.js'), 'utf8');
}

function loadAccountSource() {
  return require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'account.js'), 'utf8');
}

test('authoritative onboarding state resolves stale bootstrap records as complete and repair is idempotent', async () => {
  const { buildOnboardingRepairPlan, getAuthoritativeOnboardingState } = await loadOnboardingStatusHelpers();
  const state = {
    user: { uid: 'user-1', email: 'owner@example.com' },
    profile: { role: 'pending', onboardingState: 'needs_company_setup' },
    company: { id: 'co-1', name: 'Scoot Business', createdBy: 'user-1', onboardingCompleted: false },
    activeMembership: { id: 'co-1_user-1', companyId: 'co-1', userId: 'user-1', role: 'owner', status: 'active' },
    companyMembers: [{ id: 'co-1_user-1', companyId: 'co-1', userId: 'user-1', role: 'owner', status: 'active' }],
    companyLocations: [{ id: 'loc-1', companyId: 'co-1', name: 'Main Floor' }]
  };

  const resolved = getAuthoritativeOnboardingState(state);
  assert.equal(resolved.complete, true);
  assert.equal(resolved.badgeLabel, 'Complete');
  assert.equal(resolved.normalizedRole, 'owner');

  const firstPlan = buildOnboardingRepairPlan(state);
  assert.equal(firstPlan.needsRepair, true);
  assert.deepEqual(firstPlan.userPatch, { onboardingState: 'complete', role: 'owner' });
  assert.deepEqual(firstPlan.companyPatch && Object.keys(firstPlan.companyPatch).sort(), ['onboardingCompleted', 'onboardingCompletedAt', 'onboardingState']);
  assert.equal(firstPlan.membershipPatch, null);

  const repairedState = {
    ...state,
    profile: { ...state.profile, ...firstPlan.userPatch },
    company: { ...state.company, ...firstPlan.companyPatch }
  };
  const secondPlan = buildOnboardingRepairPlan(repairedState);
  assert.equal(secondPlan.needsRepair, false);
  assert.equal(getAuthoritativeOnboardingState(repairedState).complete, true);
});

test('authoritative onboarding state upgrades a pending membership role for the company creator when setup is complete', async () => {
  const { buildOnboardingRepairPlan } = await loadOnboardingStatusHelpers();
  const state = {
    user: { uid: 'user-1', email: 'owner@example.com' },
    profile: { role: 'pending', onboardingState: 'needs_company_setup' },
    company: { id: 'co-1', name: 'Scoot Business', createdBy: 'user-1', onboardingCompleted: false },
    activeMembership: { id: 'co-1_user-1', companyId: 'co-1', userId: 'user-1', role: 'pending', status: 'active' },
    companyMembers: [{ id: 'co-1_user-1', companyId: 'co-1', userId: 'user-1', role: 'pending', status: 'active' }],
    companyLocations: [{ id: 'loc-1', companyId: 'co-1', name: 'Main Floor' }]
  };

  const plan = buildOnboardingRepairPlan(state);
  assert.equal(plan.needsRepair, true);
  assert.deepEqual(plan.userPatch, { onboardingState: 'complete', role: 'owner' });
  assert.deepEqual(plan.membershipPatch, { role: 'owner' });
});

test('app shell routes stale bootstrap repairs through the callable flow instead of direct browser writes', () => {
  const source = loadAppShellSource();
  const repairStart = source.indexOf('async function repairOperationalOnboardingState()');
  const refreshStart = source.indexOf('async function refreshData()');
  const repairBody = source.slice(repairStart, refreshStart);

  assert.match(repairBody, /shouldFinalizeOnboardingBootstrap\(state\)/);
  assert.match(repairBody, /await finalizeOnboardingBootstrap\(state\)/);
  assert.doesNotMatch(repairBody, /saveUserProfile\(/);
  assert.doesNotMatch(repairBody, /upsertEntity\('companyMemberships'/);
  assert.doesNotMatch(repairBody, /upsertEntity\('companies'/);
});

test('account appearance UI exposes expanded presets and reset to default control', () => {
  const source = loadAccountSource();
  assert.match(source, /option value="blue"/);
  assert.match(source, /option value="dark_slate"/);
  assert.match(source, /data-reset-appearance/);
  assert.match(source, /Appearance reset to Scoot default/);
  assert.match(source, /Sending verification…/);
  assert.match(source, /Refreshing status…/);
});

test('theme helpers apply presets, custom colors, readable text fallback, and default reset shape', async () => {
  const { applyAppearancePreference, getDefaultAppearance } = await loadThemeHelpers();
  const styleMap = new Map();
  const originalDocument = global.document;
  const originalWindow = global.window;
  try {
    global.document = {
      documentElement: {
        style: {
          setProperty: (name, value) => styleMap.set(name, value)
        },
        dataset: {}
      }
    };
    global.window = { matchMedia: () => ({ matches: false }) };
    applyAppearancePreference({
      mode: 'light',
      preset: 'blue',
      textSize: 'large',
      contrast: 'high',
      motion: 'reduced',
      customColors: { primary: '#111111', accent: '#222222', background: '#000000', text: '#111111' }
    });
    assert.equal(styleMap.get('--color-primary'), '#111111');
    assert.equal(styleMap.get('--accent'), '#222222');
    assert.equal(styleMap.get('--color-text'), '#f8fafc');
    assert.equal(styleMap.get('--color-accent-text'), '#ffffff');
    assert.equal(styleMap.get('--color-danger-text'), '#ffffff');
    assert.equal(styleMap.get('--color-surface-text'), '#0b1220');
    assert.equal(global.document.documentElement.dataset.themeMode, 'light');
    assert.equal(getDefaultAppearance().preset, 'scoot_default');
  } finally {
    global.document = originalDocument;
    global.window = originalWindow;
  }
});

test('admin readiness card dismiss/show actions persist and enforce required-only completion rules', async () => {
  const { createAdminActions } = await loadAdminActions();
  const saveCalls = [];
  let refreshCount = 0;
  const state = {
    company: { id: 'co-1' },
    companyLocations: [],
    workers: [],
    settings: { aiConfiguredExplicitly: false },
    invites: [],
    assets: [],
    adminUi: {}
  };
  const actions = createAdminActions({
    state,
    render: () => {},
    refreshData: async () => { refreshCount += 1; },
    runAction: async (_label, fn) => fn(),
    withRequiredCompanyId: (payload) => payload,
    upsertEntity: async () => {},
    clearEntitySet: async () => {},
    saveAppSettings: async (payload) => { saveCalls.push(payload); },
    exportBackupJson: () => {},
    buildAssetsCsv: () => '',
    buildTasksCsv: () => '',
    buildAuditCsv: () => '',
    buildWorkersCsv: () => '',
    buildMembersCsv: () => '',
    buildInvitesCsv: () => '',
    buildLocationsCsv: () => '',
    buildCompanyBackupBundle: () => ({}),
    downloadFile: () => {},
    downloadJson: () => {},
    normalizeAssetId: (value) => value,
    enrichAssetDocumentation: async () => {},
    repairAssetDocumentationState: async () => {},
    bootstrapAttachAssetManualFromCsvHint: async () => {},
    createCompanyInvite: async () => ({}),
    revokeInvite: async () => {},
  });

  await actions.dismissReadinessCard();
  assert.equal(saveCalls.length, 0);
  assert.match(state.adminUi.message, /Complete required readiness items/i);

  state.companyLocations = [{ id: 'loc-1' }];
  state.workers = [{ id: 'worker-1' }];
  state.settings.aiConfiguredExplicitly = true;
  await actions.dismissReadinessCard();
  assert.equal(saveCalls.length, 1);
  assert.ok(saveCalls[0].workspaceReadinessDismissedAt);
  assert.equal(state.invites.length, 0);
  assert.equal(state.assets.length, 0);

  await actions.showReadinessCard();
  assert.equal(saveCalls.length, 2);
  assert.equal(saveCalls[1].workspaceReadinessDismissedAt, null);
  assert.equal(refreshCount >= 2, true);
});

test('account security actions call verification helpers and refresh profile snapshot', async () => {
  const { createAccountController } = await loadAccountController();
  const calls = [];
  const state = {
    user: { uid: 'user-1', email: 'owner@example.com' },
    profile: { emailVerified: false }
  };
  const controller = createAccountController({
    state,
    render: () => calls.push('render'),
    resendVerificationEmail: async () => calls.push('resendVerificationEmail'),
    refreshAuthUser: async () => {
      calls.push('refreshAuthUser');
      return { uid: 'user-1', email: 'owner@example.com', emailVerified: true };
    },
    syncSecuritySnapshot: async () => {
      calls.push('syncSecuritySnapshot');
      return { emailVerified: true };
    },
    sendForgotPasswordEmail: async () => {},
    persistAppearancePreference: () => {},
    withGlobalBusy: async (_title, _detail, fn) => fn()
  });
  const actions = controller.createActions();

  await actions.resendVerification();
  await actions.refreshVerification();

  assert.deepEqual(calls, [
    'resendVerificationEmail',
    'refreshAuthUser',
    'syncSecuritySnapshot',
    'render',
    'refreshAuthUser',
    'syncSecuritySnapshot',
    'render'
  ]);
});

test('admin view collapses dismissed readiness card to a compact restore link', () => {
  const adminSource = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'admin.js'), 'utf8');
  assert.match(adminSource, /Show workspace readiness/);
  assert.doesNotMatch(adminSource, /This panel is currently dismissed\./);
});

test('setup wizard stays hidden after refresh when readiness dismissal setting is present', async () => {
  const { syncSetupWizardState } = await loadStateHelpers();
  const state = {
    company: { id: 'co-1' },
    onboardingRequired: false,
    companyLocations: [],
    workers: [],
    settings: { aiConfiguredExplicitly: false, workspaceReadinessDismissedAt: new Date().toISOString() },
    setupWizard: { active: true, step: 2, message: 'previous', tone: 'warn' }
  };
  syncSetupWizardState(state);
  assert.equal(state.setupWizard.active, false);
  assert.equal(state.setupWizard.message, '');
});


test('asset manual status derivation distinguishes attached vs support-only vs review-needed vs none', async () => {
  const { deriveAssetManualStatus, filterDisplaySupportResources } = await import('./../src/features/assets.js');
  assert.equal(deriveAssetManualStatus({ manualLibraryRef: 'manual-1', manualLinks: [] }), 'manual_attached');
  assert.equal(deriveAssetManualStatus({ documentationSuggestions: [{ url: 'https://example.com/manual.pdf', verified: true, exactTitleMatch: true, exactManualMatch: true }] }), 'queued_for_review');
  assert.equal(deriveAssetManualStatus({
    manualStatus: 'support_context_only',
    documentationTextAvailable: true,
    manualChunkCount: 7,
  }), 'manual_attached');
  assert.equal(deriveAssetManualStatus({ supportResourcesSuggestion: [{ url: 'https://example.com/support', label: 'Support' }] }), 'support_context_only');
  assert.equal(deriveAssetManualStatus({ documentationSuggestions: [], supportResourcesSuggestion: [] }), 'no_public_manual');
  assert.equal(deriveAssetManualStatus({
    supportResourcesSuggestion: [
      { url: 'https://parts.laigames.com/balls/', label: 'Balls' },
      { url: 'https://parts.laigames.com/cart.php', label: 'Cart' },
      { url: 'https://parts.laigames.com/login.php', label: 'Sign In' },
      { url: 'https://parts.laigames.com/create_account.php', label: 'Register' },
    ],
  }), 'no_public_manual');
  assert.deepEqual(filterDisplaySupportResources([
    { url: 'https://parts.laigames.com/balls/', label: 'Balls' },
    { url: 'https://parts.laigames.com/cart.php', label: 'Cart' },
    { url: 'https://parts.laigames.com/login.php', label: 'Sign In' },
    { url: 'https://parts.laigames.com/create_account.php', label: 'Register' },
    { url: 'https://laigames.com/games/hypershoot/support/', label: 'HYPERshoot support' },
  ]).map((entry) => entry.url), ['https://laigames.com/games/hypershoot/support/']);
});

test('asset helpers render manual outcome states consistently', async () => {
  const { deriveAssetManualStatus, getEffectiveEnrichmentStatus } = await import('./../src/features/assets.js');
  assert.equal(deriveAssetManualStatus({ manualLibraryRef: 'manual-1', manualLinks: [] }), 'manual_attached');
  assert.equal(getEffectiveEnrichmentStatus({ manualStatus: 'attached', enrichmentStatus: 'in_progress', manualLibraryRef: 'manual-1' }), 'verified_manual_found');
  assert.equal(deriveAssetManualStatus({ manualStatus: 'support_only', supportResourcesSuggestion: [{ url: 'https://example.com/support', label: 'Support' }] }), 'support_context_only');
  assert.equal(getEffectiveEnrichmentStatus({
    manualStatus: 'support_only',
    enrichmentStatus: 'in_progress',
    supportResourcesSuggestion: [{ url: 'https://example.com/support', label: 'Support' }],
    enrichmentRequestedAt: new Date(Date.now() - (5 * 60 * 1000)).toISOString(),
    enrichmentHeartbeatAt: new Date(Date.now() - (4 * 60 * 1000)).toISOString(),
  }), 'followup_needed');
  assert.equal(deriveAssetManualStatus({ documentationSuggestions: [{ url: 'https://example.com/manual.pdf', verified: true, exactTitleMatch: true, exactManualMatch: true }] }), 'queued_for_review');
  assert.equal(getEffectiveEnrichmentStatus({
    manualStatus: 'review_needed',
    enrichmentStatus: 'searching_docs',
    documentationSuggestions: [{ url: 'https://example.com/manual.pdf', verified: true, exactTitleMatch: true, exactManualMatch: true }],
    enrichmentRequestedAt: new Date(Date.now() - (5 * 60 * 1000)).toISOString(),
    enrichmentHeartbeatAt: new Date(Date.now() - (4 * 60 * 1000)).toISOString(),
  }), 'followup_needed');
  assert.equal(deriveAssetManualStatus({ manualStatus: 'no_public_manual', documentationSuggestions: [], supportResourcesSuggestion: [] }), 'no_public_manual');
  assert.equal(getEffectiveEnrichmentStatus({
    manualStatus: 'no_public_manual',
    enrichmentStatus: 'in_progress',
    enrichmentRequestedAt: new Date(Date.now() - (5 * 60 * 1000)).toISOString(),
    enrichmentHeartbeatAt: new Date(Date.now() - (4 * 60 * 1000)).toISOString(),
  }), 'no_match_yet');
});

test('asset draft context resolves valid company and location alignment', async () => {
  const { resolveAssetDraftContext } = await loadAssetDraftContextHelpers();
  const context = resolveAssetDraftContext({
    activeMembership: { companyId: 'company-a' },
    company: { id: 'company-a' },
    companyLocations: [{ id: 'loc-1', companyId: 'company-a', name: 'Main Floor' }],
    assetDraft: { locationId: 'loc-1', locationName: 'Main Floor' }
  });

  assert.equal(context.ok, true);
  assert.equal(context.resolvedCompanyId, 'company-a');
  assert.equal(context.selectedLocationCompanyId, 'company-a');
  assert.equal(context.stamp, 'company-a|loc-1|main floor');
});

test('asset draft context blocks mismatched location company and unresolved membership', async () => {
  const { resolveAssetDraftContext } = await loadAssetDraftContextHelpers();

  const unresolved = resolveAssetDraftContext({
    activeMembership: null,
    company: { id: 'company-a' },
    companyLocations: [],
    assetDraft: {}
  });
  assert.equal(unresolved.ok, false);
  assert.equal(unresolved.reason, 'membership_unresolved');

  const mismatch = resolveAssetDraftContext({
    activeMembership: { companyId: 'company-a' },
    company: { id: 'company-a' },
    companyLocations: [{ id: 'loc-2', companyId: 'company-b', name: 'Prize Zone' }],
    assetDraft: { locationId: 'loc-2' }
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, 'location_company_mismatch');
});

test('asset actions block save before Firestore write when company context is unresolved', async () => {
  const { createAssetActions } = await loadAssetActions();
  const state = {
    assetDraft: {
      name: 'Quick Drop',
      manufacturer: 'Bay Tek Games',
      locationId: '',
      locationName: '',
      preview: null,
      previewContext: null,
      previewStatus: 'idle',
      previewMeta: { inFlightQuery: '', lastCompletedQuery: '' }
    },
    assets: [],
    companyLocations: [],
    permissions: { companyRole: 'owner', role: 'owner' },
    activeMembership: null,
    company: { id: 'company-a' },
    user: { uid: 'user-1' },
    assetUi: {}
  };
  let upsertCalls = 0;
  let renders = 0;
  const actions = createAssetActions({
    state,
    onLocationFilter: () => {},
    render: () => { renders += 1; },
    refreshData: async () => {},
    withRequiredCompanyId: (payload) => payload,
    upsertEntity: async () => { upsertCalls += 1; },
    deleteEntity: async () => {},
    approveAssetManual: async () => {},
    enrichAssetDocumentation: async () => {},
    previewAssetDocumentationLookup: async () => ({}),
    researchAssetTitles: async () => ({}),
    markAssetEnrichmentFailure: async () => ({}),
    normalizeAssetId: (name) => `asset-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    pickUniqueAssetId: (id) => id,
    createEmptyAssetDraft: () => ({ previewMeta: { inFlightQuery: '', lastCompletedQuery: '' } }),
    withTimeout: async (promise) => promise,
    normalizeSupportEntries: (entries) => entries,
    canDelete: () => false,
    isAdmin: () => true,
    isManager: () => true,
    buildAssetSaveErrorMessage: (error) => `${error.message}`,
    buildAssetSaveDebugContext: () => ({ companyId: 'company-a', companyRole: 'owner' }),
    isPermissionRelatedError: () => false,
    buildPreviewQueryKey: () => ''
  });

  await actions.saveAsset('', { name: 'Quick Drop', manufacturer: 'Bay Tek Games' });

  assert.equal(upsertCalls, 0);
  assert.match(state.assetDraft.saveFeedback, /membership is still loading/i);
  assert.ok(renders >= 1);
});

test('asset actions surface weak lookup warning before save for ambiguous add/edit titles', async () => {
  const { createAssetActions } = await loadAssetActions();
  const state = {
    assetDraft: {
      name: 'VR',
      manufacturer: 'LAI',
      locationId: '',
      locationName: '',
      preview: null,
      previewContext: null,
      previewStatus: 'idle',
      previewMeta: { inFlightQuery: '', lastCompletedQuery: '' }
    },
    assets: [],
    companyLocations: [],
    permissions: { companyRole: 'owner', role: 'owner' },
    activeMembership: { companyId: 'company-a' },
    company: { id: 'company-a' },
    user: { uid: 'user-1' },
    assetUi: {}
  };
  const actions = createAssetActions({
    state,
    onLocationFilter: () => {},
    render: () => {},
    refreshData: async () => {},
    withRequiredCompanyId: (payload) => payload,
    upsertEntity: async () => {},
    deleteEntity: async () => {},
    approveAssetManual: async () => {},
    enrichAssetDocumentation: async () => {},
    previewAssetDocumentationLookup: async () => ({}),
    researchAssetTitles: async () => ({}),
    markAssetEnrichmentFailure: async () => ({}),
    normalizeAssetId: (name) => `asset-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    pickUniqueAssetId: (id) => id,
    createEmptyAssetDraft: () => ({ previewMeta: { inFlightQuery: '', lastCompletedQuery: '' } }),
    withTimeout: async (promise) => promise,
    normalizeSupportEntries: (entries) => entries,
    canDelete: () => false,
    isAdmin: () => true,
    isManager: () => true,
    buildAssetSaveErrorMessage: () => 'error',
    buildAssetSaveDebugContext: () => ({ companyId: 'company-a', companyRole: 'owner' }),
    isPermissionRelatedError: () => false,
    buildPreviewQueryKey: () => ''
  });

  await actions.saveAsset('', { name: 'VR', manufacturer: 'LAI' });

  assert.match(state.assetDraft.saveSecondaryFeedback || '', /look weak for manual lookup/i);
});

test('assets view renders bulk visible doc re-search action and disables it while running', async () => {
  const { renderAssets } = await loadAssetsHelpers();
  const state = {
    permissions: { companyRole: 'owner', role: 'owner' },
    tasks: [],
    pmSchedules: [],
    taskAiRuns: [],
    manuals: [],
    auditLogs: [],
    troubleshootingLibrary: [],
    companyLocations: [],
    route: { tab: 'assets', location: 'all', assetFilter: 'all' },
    assetDraft: {},
    assetUi: { searchQuery: '', statusFilter: 'all', reviewFilter: 'all', enrichmentFilter: 'all', bulkDocRerunStatus: 'running', bulkDocRerunProgress: { totalTargeted: 2, completed: 1, succeeded: 1, failed: 0, skipped: 0, currentAssetId: 'asset-2', currentAssetName: 'Asset Two' }, bulkDocRerunSummary: '' },
    assets: [
      { id: 'asset-1', name: 'Asset One', manufacturer: 'Mfr', locationId: '', locationName: '', enrichmentStatus: 'idle' },
      { id: 'asset-2', name: 'Asset Two', manufacturer: 'Mfr', locationId: '', locationName: '', enrichmentStatus: 'idle' }
    ]
  };
  const el = { innerHTML: '', querySelector: () => null, querySelectorAll: () => [] };
  const actions = { setLocationFilter: () => {}, runBulkAssetEnrichment: () => {} };
  renderAssets(el, state, actions);
  assert.match(el.innerHTML, /Re-search docs for all visible assets/);
  assert.match(el.innerHTML, /data-bulk-visible-enrich class="primary" disabled/);
  assert.match(el.innerHTML, /Re-searching docs: 1 \/ 2 complete/);
});

test('assets tab renders create-task action on expanded asset cards for task-capable users', async () => {
  const { renderAssets } = await loadAssetsHelpers();
  const state = {
    permissions: { companyRole: 'staff', role: 'staff' },
    user: { uid: 'user-1', email: 'staff@example.com' },
    tasks: [],
    pmSchedules: [],
    taskAiRuns: [],
    manuals: [],
    auditLogs: [],
    troubleshootingLibrary: [],
    companyLocations: [{ id: 'loc-1', name: 'Front Floor', companyId: 'company-a' }],
    route: { tab: 'assets', locationKey: 'loc-1', assetFilter: 'all', assetId: 'asset-1' },
    assetDraft: {},
    assetUi: { searchQuery: '', statusFilter: 'all', reviewFilter: 'all', enrichmentFilter: 'all' },
    assets: [{ id: 'asset-1', name: 'Hyper Shot', manufacturer: 'LAI', locationId: 'loc-1', locationName: 'Front Floor', enrichmentStatus: 'idle' }]
  };
  const el = { innerHTML: '', querySelector: () => null, querySelectorAll: () => [] };
  const actions = { setLocationFilter: () => {}, runBulkAssetEnrichment: () => {}, createTaskForAsset: () => {} };
  renderAssets(el, state, actions);

  assert.match(el.innerHTML, /Create task for this asset/);
  assert.match(el.innerHTML, /data-create-task-for-asset="asset-1"/);
});

test('assets create-task action click routes through createTaskForAsset handler', async () => {
  const { renderAssets } = await loadAssetsHelpers();
  const createTaskButton = {
    dataset: {
      createTaskForAsset: 'asset-1',
      locationKey: encodeURIComponent('loc-1'),
      locationLabel: encodeURIComponent('Front Floor')
    },
    addEventListener(_type, handler) {
      this._handler = handler;
    }
  };
  const el = {
    innerHTML: '',
    querySelector: () => null,
    querySelectorAll: (selector) => (selector === '[data-create-task-for-asset]' ? [createTaskButton] : [])
  };
  const state = {
    permissions: { companyRole: 'staff', role: 'staff' },
    user: { uid: 'user-1', email: 'staff@example.com' },
    tasks: [],
    pmSchedules: [],
    taskAiRuns: [],
    manuals: [],
    auditLogs: [],
    troubleshootingLibrary: [],
    companyLocations: [{ id: 'loc-1', name: 'Front Floor', companyId: 'company-a' }],
    route: { tab: 'assets', locationKey: 'loc-1', assetFilter: 'all', assetId: 'asset-1' },
    assetDraft: {},
    assetUi: { searchQuery: '', statusFilter: 'all', reviewFilter: 'all', enrichmentFilter: 'all' },
    assets: [{ id: 'asset-1', name: 'Hyper Shot', manufacturer: 'LAI', locationId: 'loc-1', locationName: 'Front Floor', enrichmentStatus: 'idle' }]
  };
  const calls = [];
  const actions = {
    setLocationFilter: () => {},
    runBulkAssetEnrichment: () => {},
    createTaskForAsset: (...args) => calls.push(args)
  };
  renderAssets(el, state, actions);
  createTaskButton._handler();
  assert.deepEqual(calls, [['asset-1', { locationKey: 'loc-1', locationScopeLabel: 'Front Floor' }]]);
});

test('assets view shows manual text extraction state chips and repair actions for manager role', async () => {
  const { renderAssets } = await loadAssetsHelpers();
  const state = {
    permissions: { companyRole: 'manager', role: 'manager' },
    tasks: [],
    pmSchedules: [],
    taskAiRuns: [],
    manuals: [],
    auditLogs: [],
    troubleshootingLibrary: [],
    companyLocations: [],
    route: { tab: 'assets', location: 'all', assetFilter: 'all' },
    assetDraft: {},
    assetUi: { searchQuery: '', statusFilter: 'all', reviewFilter: 'all', enrichmentFilter: 'all' },
    assets: [
      { id: 'asset-zero', name: 'Asset Zero', manufacturer: 'Mfr', manualStatus: 'manual_attached', manualStoragePath: 'companies/company-a/manuals/asset-zero/source.pdf', manualChunkCount: 0 },
      { id: 'asset-ready', name: 'Asset Ready', manufacturer: 'Mfr', manualStatus: 'manual_attached', manualStoragePath: 'companies/company-a/manuals/asset-ready/source.pdf', manualChunkCount: 12, manualTextExtractionStatus: 'completed', documentationTextAvailable: true }
    ]
  };
  const el = { innerHTML: '', querySelector: () => null, querySelectorAll: () => [] };
  const actions = { setLocationFilter: () => {}, runBulkAssetEnrichment: () => {}, repairAssetManualText: () => {} };
  renderAssets(el, state, actions);

  assert.match(el.innerHTML, /Manual attached — text not extracted/);
  assert.match(el.innerHTML, /Manual text available/);
  assert.match(el.innerHTML, /data-reextract-manual-text="asset-zero"/);
  assert.match(el.innerHTML, /data-check-manual-text="asset-zero"/);
});

test('assets view does not show missing manual message when extracted manual evidence exists', async () => {
  const { renderAssets } = await loadAssetsHelpers();
  const state = {
    permissions: { companyRole: 'manager', role: 'manager' },
    tasks: [],
    pmSchedules: [],
    taskAiRuns: [],
    manuals: [],
    auditLogs: [],
    troubleshootingLibrary: [],
    companyLocations: [],
    route: { tab: 'assets', location: 'all', assetFilter: 'all' },
    assetDraft: {},
    assetUi: { searchQuery: '', statusFilter: 'all', reviewFilter: 'all', enrichmentFilter: 'all' },
    assets: [{
      id: 'asset-ready',
      name: 'Asset Ready',
      manufacturer: 'Mfr',
      manualStatus: 'support_context_only',
      latestManualId: 'manual-1',
      manualChunkCount: 10,
      documentationTextAvailable: true
    }]
  };
  const el = { innerHTML: '', querySelector: () => null, querySelectorAll: () => [] };
  const actions = { setLocationFilter: () => {}, runBulkAssetEnrichment: () => {}, repairAssetManualText: () => {} };
  renderAssets(el, state, actions);

  assert.doesNotMatch(el.innerHTML, /No attached manual yet\. Run lookup or approve a suggested manual below\./);
  assert.match(el.innerHTML, /Attached manual text available|Manual text available from attached manual\./);
});

test('assets view shows csv bootstrap manual storage evidence and prioritizes manual text available label', async () => {
  const { renderAssets } = await loadAssetsHelpers();
  const state = {
    permissions: { companyRole: 'manager', role: 'manager' },
    tasks: [],
    pmSchedules: [],
    taskAiRuns: [],
    manuals: [],
    auditLogs: [],
    troubleshootingLibrary: [],
    companyLocations: [],
    route: { tab: 'assets', location: 'all', assetFilter: 'all' },
    assetDraft: {},
    assetUi: { searchQuery: '', statusFilter: 'all', reviewFilter: 'all', enrichmentFilter: 'all' },
    assets: [{
      id: 'asset-bootstrap',
      name: 'Asset Bootstrap',
      manufacturer: 'Mfr',
      manualStatus: 'support_context_only',
      documentationTextAvailable: true,
      manualChunkCount: 1,
      csvBootstrapManualAttach: {
        manualStoragePath: 'companies/company-a/manuals/asset-bootstrap/source.pdf'
      }
    }]
  };
  const el = { innerHTML: '', querySelector: () => null, querySelectorAll: () => [] };
  const actions = { setLocationFilter: () => {}, runBulkAssetEnrichment: () => {}, repairAssetManualText: () => {} };
  renderAssets(el, state, actions);

  assert.match(el.innerHTML, /data-manual-storage-path="companies%2Fcompany-a%2Fmanuals%2Fasset-bootstrap%2Fsource\.pdf"/);
  assert.match(el.innerHTML, /Manual outcome: manual text available/);
  assert.doesNotMatch(el.innerHTML, /Manual outcome: support links only/);
});

test('assets view hides stale follow-up card after answered terminal no-match state', async () => {
  const { renderAssets } = await loadAssetsHelpers();
  const state = {
    permissions: { companyRole: 'manager', role: 'manager' },
    tasks: [],
    pmSchedules: [],
    taskAiRuns: [],
    manuals: [],
    auditLogs: [],
    troubleshootingLibrary: [],
    companyLocations: [],
    route: { tab: 'assets', location: 'all', assetFilter: 'all' },
    assetDraft: {},
    assetUi: { searchQuery: '', statusFilter: 'all', reviewFilter: 'all', enrichmentFilter: 'all' },
    assets: [{
      id: 'asset-followup',
      name: 'Virtual Rabbids',
      manufacturer: 'LAI Games',
      enrichmentStatus: 'no_match_yet',
      enrichmentFollowupQuestion: 'Is the cabinet nameplate manufacturer and model readable?',
      documentationFollowupStatus: 'answered',
      manualStatus: 'support_context_only',
      supportResourcesSuggestion: [{ url: 'https://example.com/support', title: 'Support' }]
    }]
  };
  const el = { innerHTML: '', querySelector: () => null, querySelectorAll: () => [] };
  const actions = { setLocationFilter: () => {}, runBulkAssetEnrichment: () => {}, repairAssetManualText: () => {} };
  renderAssets(el, state, actions);

  assert.doesNotMatch(el.innerHTML, /Need one detail to improve the match/);
  assert.match(el.innerHTML, /Lookup completed using your answer\. No reviewable manual was found yet\./);
});

test('asset actions bulk doc re-search uses visible ids, processes queued imports, and records progress summary', async () => {
  const { createAssetActions } = await loadAssetActions();
  const state = {
    assetDraft: { previewMeta: { inFlightQuery: '', lastCompletedQuery: '' } },
    assetUi: {},
    assets: [
      { id: 'asset-a', name: 'Asset A', enrichmentStatus: 'idle' },
      { id: 'asset-b', name: 'Asset B', enrichmentStatus: 'queued' },
      { id: 'asset-c', name: 'Asset C', enrichmentStatus: 'idle' }
    ],
    companyLocations: [],
    permissions: { companyRole: 'owner', role: 'owner' },
    activeMembership: { companyId: 'company-a' },
    company: { id: 'company-a' },
    user: { uid: 'user-1' }
  };
  const enrichCalls = [];
  const actions = createAssetActions({
    state,
    onLocationFilter: () => {},
    render: () => {},
    refreshData: async () => {},
    withRequiredCompanyId: (payload) => payload,
    upsertEntity: async () => {},
    deleteEntity: async () => {},
    approveAssetManual: async () => {},
    enrichAssetDocumentation: async (id) => {
      enrichCalls.push(id);
      if (id === 'asset-c') throw new Error('lookup failed');
      return { status: 'no_match_yet' };
    },
    previewAssetDocumentationLookup: async () => ({}),
    researchAssetTitles: async () => ({}),
    markAssetEnrichmentFailure: async () => ({ message: 'failure marked' }),
    normalizeAssetId: (name) => name,
    pickUniqueAssetId: (id) => id,
    createEmptyAssetDraft: () => ({ previewMeta: { inFlightQuery: '', lastCompletedQuery: '' } }),
    withTimeout: async (promise) => promise,
    normalizeSupportEntries: (entries) => entries,
    canDelete: () => false,
    isAdmin: () => true,
    isManager: () => true,
    buildAssetSaveErrorMessage: () => 'error',
    buildAssetSaveDebugContext: () => ({}),
    isPermissionRelatedError: () => false,
    buildPreviewQueryKey: () => ''
  });

  await actions.runBulkAssetEnrichment(['asset-a', 'asset-b', 'asset-c'], { confirmStart: false, requestDelayMs: 0 });

  assert.deepEqual(enrichCalls, ['asset-a', 'asset-b', 'asset-c']);
  assert.equal(state.assetUi.bulkDocRerunStatus, 'idle');
  assert.equal(state.assetUi.bulkDocRerunProgress.totalTargeted, 3);
  assert.equal(state.assetUi.bulkDocRerunProgress.succeeded, 2);
  assert.equal(state.assetUi.bulkDocRerunProgress.failed, 1);
  assert.equal(state.assetUi.bulkDocRerunProgress.skipped, 0);
  assert.match(state.assetUi.bulkDocRerunSummary, /Succeeded 2, failed 1, skipped 0/);
});

test('asset actions create-task helper prefills repair draft flow and navigates to operations route alias', async () => {
  const { createAssetActions } = await loadAssetActions();
  const state = {
    operationsUi: { draft: { reporter: 'staff@example.com' } },
    assetDraft: { previewMeta: { inFlightQuery: '', lastCompletedQuery: '' } },
    assetUi: {},
    assets: [{ id: 'asset-1', name: 'Hyper Shot', locationName: 'Front Floor' }],
    companyLocations: [],
    permissions: { companyRole: 'staff', role: 'staff' },
    activeMembership: { companyId: 'company-a' },
    company: { id: 'company-a' },
    user: { uid: 'user-1', email: 'staff@example.com' }
  };
  const navCalls = [];
  const actions = createAssetActions({
    state,
    onLocationFilter: () => {},
    onCreateTaskForAsset: (payload) => navCalls.push(payload),
    render: () => {},
    refreshData: async () => {},
    withRequiredCompanyId: (payload) => payload,
    upsertEntity: async () => {},
    deleteEntity: async () => {},
    approveAssetManual: async () => {},
    enrichAssetDocumentation: async () => {},
    previewAssetDocumentationLookup: async () => ({}),
    researchAssetTitles: async () => ({}),
    markAssetEnrichmentFailure: async () => ({}),
    normalizeAssetId: (name) => name,
    pickUniqueAssetId: (id) => id,
    createEmptyAssetDraft: () => ({ previewMeta: { inFlightQuery: '', lastCompletedQuery: '' } }),
    withTimeout: async (promise) => promise,
    normalizeSupportEntries: (entries) => entries,
    canDelete: () => false,
    isAdmin: () => true,
    isManager: () => true,
    buildAssetSaveErrorMessage: () => 'error',
    buildAssetSaveDebugContext: () => ({}),
    isPermissionRelatedError: () => false,
    buildPreviewQueryKey: () => ''
  });

  actions.createTaskForAsset('asset-1', { locationKey: 'loc-1', locationScopeLabel: 'Front Floor' });

  assert.equal(state.operationsUi.draft.assetSearch, 'Hyper Shot');
  assert.equal(state.operationsUi.draft.location, 'Front Floor');
  assert.equal(state.operationsUi.draft.status, 'open');
  assert.equal(state.operationsUi.draft.reporter, 'staff@example.com');
  assert.deepEqual(navCalls, [{ locationKey: 'loc-1', locationScopeLabel: 'Front Floor' }]);
});

test('asset actions submit follow-up answer uses canonical asset id/company and followup trigger', async () => {
  const { createAssetActions } = await loadAssetActions();
  const enrichCalls = [];
  const busyCalls = [];
  const state = {
    assetDraft: { previewMeta: { inFlightQuery: '', lastCompletedQuery: '' } },
    assetUi: {},
    assets: [{
      id: 'legacy-id',
      firestoreDocId: 'asset-doc-1',
      storedAssetId: 'legacy-id',
      name: 'Virtual Rabbids',
      companyId: 'company-a',
      enrichmentFollowupQuestion: 'What exact subtitle/version is on the cabinet?'
    }],
    companyLocations: [],
    permissions: { companyRole: 'manager', role: 'manager' },
    activeMembership: { companyId: 'company-a' },
    company: { id: 'company-a' },
    user: { uid: 'user-1' }
  };
  const actions = createAssetActions({
    state,
    onLocationFilter: () => {},
    render: () => {},
    refreshData: async () => {},
    withRequiredCompanyId: (payload) => payload,
    upsertEntity: async () => {},
    deleteEntity: async () => {},
    approveAssetManual: async () => {},
    enrichAssetDocumentation: async (assetId, payload) => {
      enrichCalls.push({ assetId, payload });
      return { status: 'no_match_yet' };
    },
    previewAssetDocumentationLookup: async () => ({}),
    researchAssetTitles: async () => ({}),
    markAssetEnrichmentFailure: async () => ({ message: 'failed' }),
    normalizeAssetId: (name) => name,
    pickUniqueAssetId: (id) => id,
    createEmptyAssetDraft: () => ({ previewMeta: { inFlightQuery: '', lastCompletedQuery: '' } }),
    withTimeout: async (promise) => promise,
    normalizeSupportEntries: (entries) => entries,
    canDelete: () => false,
    isAdmin: () => true,
    isManager: () => true,
    buildAssetSaveErrorMessage: () => 'error',
    buildAssetSaveDebugContext: () => ({}),
    isPermissionRelatedError: () => false,
    withGlobalBusy: async (title, detail, fn) => {
      busyCalls.push({ title, detail });
      return fn();
    },
    buildPreviewQueryKey: () => ''
  });

  await actions.submitEnrichmentFollowup('asset-doc-1', '  LAI Games ');

  assert.equal(enrichCalls.length, 1);
  assert.equal(enrichCalls[0].assetId, 'asset-doc-1');
  assert.equal(enrichCalls[0].payload.trigger, 'followup_answer');
  assert.equal(enrichCalls[0].payload.followupAnswer, 'LAI Games');
  assert.equal(enrichCalls[0].payload.companyId, 'company-a');
  assert.equal(busyCalls[0].title, 'Retrying documentation lookup…');
});

test('asset actions submit follow-up URL routes to manual attach callable instead of followup enrichment', async () => {
  const { createAssetActions } = await loadAssetActions();
  const enrichCalls = [];
  const attachCalls = [];
  const state = {
    assetDraft: { previewMeta: { inFlightQuery: '', lastCompletedQuery: '' } },
    assetUi: {},
    assets: [{
      id: 'legacy-id',
      firestoreDocId: 'asset-doc-1',
      storedAssetId: 'legacy-id',
      name: 'Test Asset',
      companyId: 'company-a',
      enrichmentFollowupQuestion: 'Share a manual link',
      manualAttachStatus: 'queued',
    }],
    companyLocations: [],
    permissions: { companyRole: 'manager', role: 'manager' },
    activeMembership: { companyId: 'company-a' },
    company: { id: 'company-a' },
    user: { uid: 'user-1' }
  };
  const actions = createAssetActions({
    state,
    onLocationFilter: () => {},
    render: () => {},
    refreshData: async () => {},
    withRequiredCompanyId: (payload) => payload,
    upsertEntity: async () => {},
    deleteEntity: async () => {},
    approveAssetManual: async () => {},
    attachAssetManualFromUrl: async (payload) => {
      attachCalls.push(payload);
      return { ok: true, queued: false, chunkCount: 0 };
    },
    enrichAssetDocumentation: async (assetId, payload) => {
      enrichCalls.push({ assetId, payload });
      return {};
    },
    previewAssetDocumentationLookup: async () => ({}),
    researchAssetTitles: async () => ({}),
    markAssetEnrichmentFailure: async () => ({ message: 'failed' }),
    normalizeAssetId: (name) => name,
    pickUniqueAssetId: (id) => id,
    createEmptyAssetDraft: () => ({ previewMeta: { inFlightQuery: '', lastCompletedQuery: '' } }),
    withTimeout: async (promise) => promise,
    normalizeSupportEntries: (entries) => entries,
    canDelete: () => false,
    isAdmin: () => true,
    isManager: () => true,
    buildAssetSaveErrorMessage: () => 'error',
    buildAssetSaveDebugContext: () => ({}),
    isPermissionRelatedError: () => false,
    withGlobalBusy: async (_title, _detail, fn) => fn(),
    buildPreviewQueryKey: () => ''
  });

  await actions.submitEnrichmentFollowup('asset-doc-1', 'https://example.com/ops-manual.pdf');
  assert.equal(attachCalls.length, 1);
  assert.equal(enrichCalls.length, 0);
  assert.equal(state.assetUi.followupByAsset['asset-doc-1'].followupAnswer, '');
});

test('asset actions retry without answer clears follow-up draft and uses retry-without-answer trigger', async () => {
  const { createAssetActions } = await loadAssetActions();
  const enrichCalls = [];
  const state = {
    assetDraft: { previewMeta: { inFlightQuery: '', lastCompletedQuery: '' } },
    assetUi: { followupByAsset: { 'asset-doc-1': { followupAnswer: 'stale answer' } } },
    assets: [{ id: 'legacy-id', firestoreDocId: 'asset-doc-1', storedAssetId: 'legacy-id', name: 'Virtual Rabbids', companyId: 'company-a' }],
    companyLocations: [],
    permissions: { companyRole: 'manager', role: 'manager' },
    activeMembership: { companyId: 'company-a' },
    company: { id: 'company-a' },
    user: { uid: 'user-1' }
  };
  const actions = createAssetActions({
    state,
    onLocationFilter: () => {},
    render: () => {},
    refreshData: async () => {},
    withRequiredCompanyId: (payload) => payload,
    upsertEntity: async () => {},
    deleteEntity: async () => {},
    approveAssetManual: async () => {},
    enrichAssetDocumentation: async (assetId, payload) => {
      enrichCalls.push({ assetId, payload });
      return { status: 'no_match_yet' };
    },
    previewAssetDocumentationLookup: async () => ({}),
    researchAssetTitles: async () => ({}),
    markAssetEnrichmentFailure: async () => ({ message: 'failed' }),
    normalizeAssetId: (name) => name,
    pickUniqueAssetId: (id) => id,
    createEmptyAssetDraft: () => ({ previewMeta: { inFlightQuery: '', lastCompletedQuery: '' } }),
    withTimeout: async (promise) => promise,
    normalizeSupportEntries: (entries) => entries,
    canDelete: () => false,
    isAdmin: () => true,
    isManager: () => true,
    buildAssetSaveErrorMessage: () => 'error',
    buildAssetSaveDebugContext: () => ({}),
    isPermissionRelatedError: () => false,
    withGlobalBusy: async (_title, _detail, fn) => fn(),
    buildPreviewQueryKey: () => ''
  });

  await actions.retryEnrichmentWithoutFollowupAnswer('asset-doc-1');

  assert.equal(enrichCalls.length, 1);
  assert.equal(enrichCalls[0].assetId, 'asset-doc-1');
  assert.equal(enrichCalls[0].payload.trigger, 'followup_retry_without_answer');
  assert.equal(state.assetUi.followupByAsset['asset-doc-1'].followupAnswer, '');
});

test('asset actions manual text repair calls callable and refreshes asset data', async () => {
  const { createAssetActions } = await loadAssetActions();
  const repairCalls = [];
  let refreshCalls = 0;
  const state = {
    assetDraft: { previewMeta: { inFlightQuery: '', lastCompletedQuery: '' } },
    assetUi: {},
    assets: [{ id: 'legacy-asset-a', firestoreDocId: 'asset-a', storedAssetId: 'legacy-asset-a', name: 'Asset A', manualStoragePath: 'companies/company-a/manuals/asset-a/source.pdf', manualStatus: 'manual_attached' }],
    companyLocations: [],
    permissions: { companyRole: 'manager', role: 'manager' },
    activeMembership: { companyId: 'company-a' },
    company: { id: 'company-a' },
    user: { uid: 'user-1' }
  };
  const actions = createAssetActions({
    state,
    onLocationFilter: () => {},
    render: () => {},
    refreshData: async () => { refreshCalls += 1; },
    withRequiredCompanyId: (payload) => payload,
    upsertEntity: async () => {},
    deleteEntity: async () => {},
    approveAssetManual: async () => {},
    repairAssetDocumentationState: async (payload) => {
      repairCalls.push(payload);
      return {
        manualMaterialization: {
          entries: [{ action: 'reextracted', newChunkCount: 12, newExtractionStatus: 'completed' }]
        }
      };
    },
    enrichAssetDocumentation: async () => ({}),
    previewAssetDocumentationLookup: async () => ({}),
    researchAssetTitles: async () => ({}),
    markAssetEnrichmentFailure: async () => ({}),
    normalizeAssetId: (name) => name,
    pickUniqueAssetId: (id) => id,
    createEmptyAssetDraft: () => ({ previewMeta: { inFlightQuery: '', lastCompletedQuery: '' } }),
    withTimeout: async (promise) => promise,
    normalizeSupportEntries: (entries) => entries,
    canDelete: () => false,
    isAdmin: () => true,
    isManager: () => true,
    buildAssetSaveErrorMessage: () => 'error',
    buildAssetSaveDebugContext: () => ({}),
    isPermissionRelatedError: () => false,
    buildPreviewQueryKey: () => ''
  });

  await actions.repairAssetManualText('asset-a', { dryRun: false });

  assert.deepEqual(repairCalls, [{ assetId: 'asset-a', assetDocId: 'asset-a', dryRun: false }]);
  assert.equal(refreshCalls, 1);
  assert.match(state.assetUi.lastActionByAsset['asset-a'].message, /Manual text extracted: 12 chunks created/);
});



test('asset actions attach manual from URL uses exact asset.id and callable payload', async () => {
  const { createAssetActions } = await loadAssetActions();
  const attachCalls = [];
  const state = {
    assetDraft: { previewMeta: { inFlightQuery: '', lastCompletedQuery: '' } },
    assetUi: {},
    assets: [{ id: 'legacy-name', firestoreDocId: 'asset-doc-123', storedAssetId: 'legacy-name', name: 'SpongeBob', companyId: 'company-a' }],
    companyLocations: [],
    permissions: { companyRole: 'manager', role: 'manager' },
    activeMembership: { companyId: 'company-a' },
    company: { id: 'company-a' },
    user: { uid: 'user-1' }
  };
  const actions = createAssetActions({
    state,
    onLocationFilter: () => {},
    render: () => {},
    refreshData: async () => {},
    withRequiredCompanyId: (payload) => payload,
    upsertEntity: async () => {},
    deleteEntity: async () => {},
    approveAssetManual: async () => {},
    attachAssetManualFromUrl: async (payload) => {
      attachCalls.push(payload);
      return { chunkCount: 0 };
    },
    attachAssetManualFromStoragePath: async () => ({}),
    enrichAssetDocumentation: async () => ({}),
    previewAssetDocumentationLookup: async () => ({}),
    researchAssetTitles: async () => ({}),
    markAssetEnrichmentFailure: async () => ({}),
    normalizeAssetId: (name) => name,
    pickUniqueAssetId: (id) => id,
    createEmptyAssetDraft: () => ({ previewMeta: { inFlightQuery: '', lastCompletedQuery: '' } }),
    withTimeout: async (promise) => promise,
    normalizeSupportEntries: (entries) => entries,
    canDelete: () => false,
    isAdmin: () => true,
    isManager: () => true,
    buildAssetSaveErrorMessage: () => 'error',
    buildAssetSaveDebugContext: () => ({}),
    isPermissionRelatedError: () => false,
    buildPreviewQueryKey: () => ''
  });

  await actions.attachManualFromUrl('asset-doc-123', { manualUrl: 'https://example.com/manual.pdf', sourceTitle: 'Manual' });

  assert.equal(attachCalls.length, 1);
  assert.equal(attachCalls[0].assetId, 'asset-doc-123');
  assert.equal(attachCalls[0].assetDocId, 'asset-doc-123');
  assert.equal(attachCalls[0].storedAssetId, 'legacy-name');
  assert.equal(attachCalls[0].manualUrl, 'https://example.com/manual.pdf');
  assert.equal(attachCalls[0].companyId, 'company-a');
});

test('asset actions attach manual from URL queued response shows extracting state and polling completion message', async () => {
  const { createAssetActions } = await loadAssetActions();
  const state = {
    assetDraft: { previewMeta: { inFlightQuery: '', lastCompletedQuery: '' } },
    assetUi: {},
    assets: [{ id: 'asset-doc-queued', firestoreDocId: 'asset-doc-queued', name: 'Queued Asset', companyId: 'company-a', manualAttachStatus: 'queued' }],
    companyLocations: [],
    permissions: { companyRole: 'manager', role: 'manager' },
    activeMembership: { companyId: 'company-a' },
    company: { id: 'company-a' },
    user: { uid: 'user-1' }
  };
  let refreshCalls = 0;
  const actions = createAssetActions({
    state,
    onLocationFilter: () => {},
    render: () => {},
    refreshData: async () => {
      refreshCalls += 1;
      if (refreshCalls > 1) {
        state.assets = [{ id: 'asset-doc-queued', firestoreDocId: 'asset-doc-queued', name: 'Queued Asset', companyId: 'company-a', manualAttachStatus: 'completed', manualChunkCount: 6, extractedCodeCount: 2 }];
      }
    },
    withRequiredCompanyId: (payload) => payload,
    upsertEntity: async () => {},
    deleteEntity: async () => {},
    approveAssetManual: async () => {},
    attachAssetManualFromUrl: async () => ({ ok: true, queued: true, jobId: 'job-queued' }),
    enrichAssetDocumentation: async () => ({}),
    previewAssetDocumentationLookup: async () => ({}),
    researchAssetTitles: async () => ({}),
    markAssetEnrichmentFailure: async () => ({}),
    normalizeAssetId: (name) => name,
    pickUniqueAssetId: (id) => id,
    createEmptyAssetDraft: () => ({ previewMeta: { inFlightQuery: '', lastCompletedQuery: '' } }),
    withTimeout: async (promise) => promise,
    normalizeSupportEntries: (entries) => entries,
    canDelete: () => false,
    isAdmin: () => true,
    isManager: () => true,
    buildAssetSaveErrorMessage: () => 'error',
    buildAssetSaveDebugContext: () => ({}),
    isPermissionRelatedError: () => false,
    withGlobalBusy: async (_title, _detail, fn) => fn(),
    buildPreviewQueryKey: () => ''
  });

  await actions.attachManualFromUrl('asset-doc-queued', { manualUrl: 'https://example.com/manual.pdf' });
  assert.match(state.assetUi.manualAttachByAsset['asset-doc-queued'].message, /text extracted: 6 chunks, 2 codes/);
});

test('asset actions attach manual from URL shows warning message for completed_with_warnings extraction failures', async () => {
  const { createAssetActions } = await loadAssetActions();
  const state = {
    assetDraft: { previewMeta: { inFlightQuery: '', lastCompletedQuery: '' } },
    assetUi: {},
    assets: [{ id: 'asset-doc-warn', firestoreDocId: 'asset-doc-warn', name: 'Warn Asset', companyId: 'company-a', manualAttachStatus: 'queued' }],
    companyLocations: [],
    permissions: { companyRole: 'manager', role: 'manager' },
    activeMembership: { companyId: 'company-a' },
    company: { id: 'company-a' },
    user: { uid: 'user-1' }
  };
  let refreshCalls = 0;
  const actions = createAssetActions({
    state,
    onLocationFilter: () => {},
    render: () => {},
    refreshData: async () => {
      refreshCalls += 1;
      if (refreshCalls > 1) {
        state.assets = [{
          id: 'asset-doc-warn',
          firestoreDocId: 'asset-doc-warn',
          name: 'Warn Asset',
          companyId: 'company-a',
          manualAttachStatus: 'completed_with_warnings',
          manualTextExtractionStatus: 'failed',
          manualChunkCount: 0
        }];
      }
    },
    withRequiredCompanyId: (payload) => payload,
    upsertEntity: async () => {},
    deleteEntity: async () => {},
    approveAssetManual: async () => {},
    attachAssetManualFromUrl: async () => ({ ok: true, queued: true, jobId: 'job-warn' }),
    enrichAssetDocumentation: async () => ({}),
    previewAssetDocumentationLookup: async () => ({}),
    researchAssetTitles: async () => ({}),
    markAssetEnrichmentFailure: async () => ({}),
    normalizeAssetId: (name) => name,
    pickUniqueAssetId: (id) => id,
    createEmptyAssetDraft: () => ({ previewMeta: { inFlightQuery: '', lastCompletedQuery: '' } }),
    withTimeout: async (promise) => promise,
    normalizeSupportEntries: (entries) => entries,
    canDelete: () => false,
    isAdmin: () => true,
    isManager: () => true,
    buildAssetSaveErrorMessage: () => 'error',
    buildAssetSaveDebugContext: () => ({}),
    isPermissionRelatedError: () => false,
    withGlobalBusy: async (_title, _detail, fn) => fn(),
    buildPreviewQueryKey: () => ''
  });

  await actions.attachManualFromUrl('asset-doc-warn', { manualUrl: 'https://example.com/manual.pdf' });
  assert.match(state.assetUi.manualAttachByAsset['asset-doc-warn'].message, /searchable text extraction failed/i);
});

test('asset actions attach manual from URL blocks blank and invalid URLs', async () => {
  const { createAssetActions } = await loadAssetActions();
  const attachCalls = [];
  const state = {
    assetDraft: { previewMeta: { inFlightQuery: '', lastCompletedQuery: '' } },
    assetUi: {},
    assets: [{ id: 'asset-doc-123', firestoreDocId: 'asset-doc-123', name: 'SpongeBob', companyId: 'company-a' }],
    companyLocations: [],
    permissions: { companyRole: 'manager', role: 'manager' },
    activeMembership: { companyId: 'company-a' },
    company: { id: 'company-a' },
    user: { uid: 'user-1' }
  };
  const actions = createAssetActions({
    state,
    onLocationFilter: () => {},
    render: () => {},
    refreshData: async () => {},
    withRequiredCompanyId: (payload) => payload,
    upsertEntity: async () => {},
    deleteEntity: async () => {},
    approveAssetManual: async () => {},
    attachAssetManualFromUrl: async (payload) => { attachCalls.push(payload); return {}; },
    attachAssetManualFromStoragePath: async () => ({}),
    enrichAssetDocumentation: async () => ({}),
    previewAssetDocumentationLookup: async () => ({}),
    researchAssetTitles: async () => ({}),
    markAssetEnrichmentFailure: async () => ({}),
    normalizeAssetId: (name) => name,
    pickUniqueAssetId: (id) => id,
    createEmptyAssetDraft: () => ({ previewMeta: { inFlightQuery: '', lastCompletedQuery: '' } }),
    withTimeout: async (promise) => promise,
    normalizeSupportEntries: (entries) => entries,
    canDelete: () => false,
    isAdmin: () => true,
    isManager: () => true,
    buildAssetSaveErrorMessage: () => 'error',
    buildAssetSaveDebugContext: () => ({}),
    isPermissionRelatedError: () => false,
    buildPreviewQueryKey: () => ''
  });

  await actions.attachManualFromUrl('asset-doc-123', { manualUrl: '   ' });
  await actions.attachManualFromUrl('asset-doc-123', { manualUrl: 'example.com/manual.pdf' });

  assert.equal(attachCalls.length, 0);
  assert.match(state.assetUi.manualAttachByAsset['asset-doc-123'].message, /Enter a valid http\(s\) manual URL\./);
});

test('asset actions upload manual blocks missing file selection', async () => {
  const { createAssetActions } = await loadAssetActions();
  let attachCalls = 0;
  const state = {
    assetDraft: { previewMeta: { inFlightQuery: '', lastCompletedQuery: '' } },
    assetUi: {},
    assets: [{ id: 'asset-doc-456', firestoreDocId: 'asset-doc-456', name: 'SpongeBob', companyId: 'company-a' }],
    companyLocations: [],
    permissions: { companyRole: 'manager', role: 'manager' },
    activeMembership: { companyId: 'company-a' },
    company: { id: 'company-a' },
    user: { uid: 'user-1' }
  };
  const actions = createAssetActions({
    state,
    onLocationFilter: () => {},
    render: () => {},
    refreshData: async () => {},
    withRequiredCompanyId: (payload) => payload,
    upsertEntity: async () => {},
    deleteEntity: async () => {},
    approveAssetManual: async () => {},
    attachAssetManualFromUrl: async () => ({}),
    attachAssetManualFromStoragePath: async () => { attachCalls += 1; return {}; },
    enrichAssetDocumentation: async () => ({}),
    previewAssetDocumentationLookup: async () => ({}),
    researchAssetTitles: async () => ({}),
    markAssetEnrichmentFailure: async () => ({}),
    normalizeAssetId: (name) => name,
    pickUniqueAssetId: (id) => id,
    createEmptyAssetDraft: () => ({ previewMeta: { inFlightQuery: '', lastCompletedQuery: '' } }),
    withTimeout: async (promise) => promise,
    normalizeSupportEntries: (entries) => entries,
    canDelete: () => false,
    isAdmin: () => true,
    isManager: () => true,
    buildAssetSaveErrorMessage: () => 'error',
    buildAssetSaveDebugContext: () => ({}),
    isPermissionRelatedError: () => false,
    buildPreviewQueryKey: () => ''
  });

  await actions.uploadAndAttachManualFile('asset-doc-456', null);

  assert.equal(attachCalls, 0);
  assert.match(state.assetUi.manualAttachByAsset['asset-doc-456'].message, /Choose a manual file first\./);
});

test('asset actions upload manual file uses exact asset.id in storage path', async () => {
  const { createAssetActions } = await loadAssetActions();
  const uploadCalls = [];
  const attachCalls = [];
  const state = {
    assetDraft: { previewMeta: { inFlightQuery: '', lastCompletedQuery: '' } },
    assetUi: {},
    assets: [{ id: 'legacy-id', firestoreDocId: 'asset-doc-456', storedAssetId: 'legacy-id', name: 'SpongeBob', companyId: 'company-a' }],
    companyLocations: [],
    permissions: { companyRole: 'manager', role: 'manager' },
    activeMembership: { companyId: 'company-a' },
    company: { id: 'company-a' },
    user: { uid: 'user-1' }
  };
  const fakeStorage = {};
  const actions = createAssetActions({
    state,
    onLocationFilter: () => {},
    render: () => {},
    refreshData: async () => {},
    withRequiredCompanyId: (payload) => payload,
    upsertEntity: async () => {},
    deleteEntity: async () => {},
    approveAssetManual: async () => {},
    attachAssetManualFromUrl: async () => ({}),
    attachAssetManualFromStoragePath: async (payload) => {
      attachCalls.push(payload);
      return { chunkCount: 0 };
    },
    enrichAssetDocumentation: async () => ({}),
    previewAssetDocumentationLookup: async () => ({}),
    researchAssetTitles: async () => ({}),
    storage: fakeStorage,
    storageRef: (_storage, path) => ({ path }),
    uploadBytes: async (ref) => { uploadCalls.push(ref.path); },
    markAssetEnrichmentFailure: async () => ({}),
    normalizeAssetId: (name) => name,
    pickUniqueAssetId: (id) => id,
    createEmptyAssetDraft: () => ({ previewMeta: { inFlightQuery: '', lastCompletedQuery: '' } }),
    withTimeout: async (promise) => promise,
    normalizeSupportEntries: (entries) => entries,
    canDelete: () => false,
    isAdmin: () => true,
    isManager: () => true,
    buildAssetSaveErrorMessage: () => 'error',
    buildAssetSaveDebugContext: () => ({}),
    isPermissionRelatedError: () => false,
    buildPreviewQueryKey: () => ''
  });

  await actions.uploadAndAttachManualFile('asset-doc-456', { name: 'ops-manual.pdf', size: 1024, type: 'application/pdf' });

  assert.equal(uploadCalls.length, 1);
  assert.match(uploadCalls[0], /^companies\/company-a\/manuals\/asset-doc-456\/manual-uploads\//);
  assert.equal(attachCalls[0].assetId, 'asset-doc-456');
  assert.equal(attachCalls[0].assetDocId, 'asset-doc-456');
  assert.equal(attachCalls[0].storedAssetId, 'legacy-id');
  assert.equal(attachCalls[0].companyId, 'company-a');
});

test('asset actions block manual attach when asset id cannot be resolved', async () => {
  const { createAssetActions } = await loadAssetActions();
  let attachCallCount = 0;
  const state = {
    assetDraft: { previewMeta: { inFlightQuery: '', lastCompletedQuery: '' } },
    assetUi: {},
    assets: [{ id: 'asset-a', name: 'Asset A', companyId: 'company-a' }],
    companyLocations: [],
    permissions: { companyRole: 'manager', role: 'manager' },
    activeMembership: { companyId: 'company-a' },
    company: { id: 'company-a' },
    user: { uid: 'user-1' }
  };
  const actions = createAssetActions({
    state,
    onLocationFilter: () => {},
    render: () => {},
    refreshData: async () => {},
    withRequiredCompanyId: (payload) => payload,
    upsertEntity: async () => {},
    deleteEntity: async () => {},
    approveAssetManual: async () => {},
    attachAssetManualFromUrl: async () => { attachCallCount += 1; return {}; },
    attachAssetManualFromStoragePath: async () => { attachCallCount += 1; return {}; },
    enrichAssetDocumentation: async () => ({}),
    previewAssetDocumentationLookup: async () => ({}),
    researchAssetTitles: async () => ({}),
    markAssetEnrichmentFailure: async () => ({}),
    normalizeAssetId: (name) => name,
    pickUniqueAssetId: (id) => id,
    createEmptyAssetDraft: () => ({ previewMeta: { inFlightQuery: '', lastCompletedQuery: '' } }),
    withTimeout: async (promise) => promise,
    normalizeSupportEntries: (entries) => entries,
    canDelete: () => false,
    isAdmin: () => true,
    isManager: () => true,
    buildAssetSaveErrorMessage: () => 'error',
    buildAssetSaveDebugContext: () => ({}),
    isPermissionRelatedError: () => false,
    buildPreviewQueryKey: () => ''
  });

  await actions.attachManualFromUrl('missing-id', { manualUrl: 'https://example.com/manual.pdf' });

  assert.equal(attachCallCount, 0);
  assert.match(state.assetUi.manualAttachByAsset['missing-id'].message, /could not be identified/i);
});

test('asset actions maps missing URL attach error to specific guidance', async () => {
  const { createAssetActions } = await loadAssetActions();
  const state = {
    assetDraft: { previewMeta: { inFlightQuery: '', lastCompletedQuery: '' } },
    assetUi: {},
    assets: [{ id: 'asset-a', firestoreDocId: 'asset-a', name: 'Asset A', companyId: 'company-a' }],
    companyLocations: [],
    permissions: { companyRole: 'manager', role: 'manager' },
    activeMembership: { companyId: 'company-a' },
    company: { id: 'company-a' },
    user: { uid: 'user-1' }
  };
  const actions = createAssetActions({
    state,
    onLocationFilter: () => {},
    render: () => {},
    refreshData: async () => {},
    withRequiredCompanyId: (payload) => payload,
    upsertEntity: async () => {},
    deleteEntity: async () => {},
    approveAssetManual: async () => {},
    attachAssetManualFromUrl: async () => { throw new Error('Manual URL is required for manual attachment.'); },
    attachAssetManualFromStoragePath: async () => ({}),
    enrichAssetDocumentation: async () => ({}),
    previewAssetDocumentationLookup: async () => ({}),
    researchAssetTitles: async () => ({}),
    markAssetEnrichmentFailure: async () => ({}),
    normalizeAssetId: (name) => name,
    pickUniqueAssetId: (id) => id,
    createEmptyAssetDraft: () => ({ previewMeta: { inFlightQuery: '', lastCompletedQuery: '' } }),
    withTimeout: async (promise) => promise,
    normalizeSupportEntries: (entries) => entries,
    canDelete: () => false,
    isAdmin: () => true,
    isManager: () => true,
    buildAssetSaveErrorMessage: () => 'error',
    buildAssetSaveDebugContext: () => ({}),
    isPermissionRelatedError: () => false,
    buildPreviewQueryKey: () => ''
  });

  await actions.attachManualFromUrl('asset-a', { manualUrl: 'https://example.com/manual.pdf' });

  assert.match(state.assetUi.manualAttachByAsset['asset-a'].message, /Manual URL is required for manual attachment\./);
});

test('asset actions maps unexpected backend attach failure to safe guidance', async () => {
  const { createAssetActions } = await loadAssetActions();
  const state = {
    assetDraft: { previewMeta: { inFlightQuery: '', lastCompletedQuery: '' } },
    assetUi: {},
    assets: [{ id: 'asset-a', firestoreDocId: 'asset-a', name: 'Asset A', companyId: 'company-a' }],
    companyLocations: [],
    permissions: { companyRole: 'manager', role: 'manager' },
    activeMembership: { companyId: 'company-a' },
    company: { id: 'company-a' },
    user: { uid: 'user-1' }
  };
  const actions = createAssetActions({
    state,
    onLocationFilter: () => {},
    render: () => {},
    refreshData: async () => {},
    withRequiredCompanyId: (payload) => payload,
    upsertEntity: async () => {},
    deleteEntity: async () => {},
    approveAssetManual: async () => {},
    attachAssetManualFromUrl: async () => { throw new Error('Manual attachment failed unexpectedly. Check function logs for details.'); },
    attachAssetManualFromStoragePath: async () => ({}),
    enrichAssetDocumentation: async () => ({}),
    previewAssetDocumentationLookup: async () => ({}),
    researchAssetTitles: async () => ({}),
    markAssetEnrichmentFailure: async () => ({}),
    normalizeAssetId: (name) => name,
    pickUniqueAssetId: (id) => id,
    createEmptyAssetDraft: () => ({ previewMeta: { inFlightQuery: '', lastCompletedQuery: '' } }),
    withTimeout: async (promise) => promise,
    normalizeSupportEntries: (entries) => entries,
    canDelete: () => false,
    isAdmin: () => true,
    isManager: () => true,
    buildAssetSaveErrorMessage: () => 'error',
    buildAssetSaveDebugContext: () => ({}),
    isPermissionRelatedError: () => false,
    buildPreviewQueryKey: () => ''
  });

  await actions.attachManualFromUrl('asset-a', { manualUrl: 'https://example.com/manual.pdf' });
  assert.equal(state.assetUi.manualAttachByAsset['asset-a'].message, 'Manual attachment failed unexpectedly. Check function logs for details.');
});
test('admin CSV import queues truthful enrichment status, starts enrichment, and keeps hint URLs non-authoritative', async () => {
  const { createAdminActions } = await loadAdminActions();
  const assets = [];
  const enrichCalls = [];
  const state = {
    user: { uid: 'user-1' },
    adminUi: { importPreview: 'Preview rows' }
  };

  const actions = createAdminActions({
    state,
    render: () => {},
    refreshData: async () => {},
    runAction: async () => {},
    withRequiredCompanyId: (payload) => payload,
    upsertEntity: async (collection, id, payload) => {
      if (collection === 'assets') assets.push({ id, payload });
    },
    clearEntitySet: async () => 0,
    saveAppSettings: async () => {},
    exportBackupJson: async () => ({}),
    buildAssetsCsv: () => '',
    buildTasksCsv: () => '',
    buildAuditCsv: () => '',
    buildWorkersCsv: () => '',
    buildMembersCsv: () => '',
    buildInvitesCsv: () => '',
    buildLocationsCsv: () => '',
    buildCompanyBackupBundle: () => ({}),
    downloadFile: () => {},
    downloadJson: () => {},
    normalizeAssetId: (value) => `${value || ''}`.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    enrichAssetDocumentation: async (assetId) => { enrichCalls.push(assetId); },
    createCompanyInvite: async () => ({}),
    revokeInvite: async () => {}
  });

  await actions.importAssets([{
    'asset name': 'Quick Drop',
    manufacturer: 'Bay Tek',
    manualHintUrl: 'https://manuals.example/quick-drop.pdf',
    manualSourceHintUrl: 'https://manuals.example/quick-drop',
    supportHintUrl: 'https://support.example/quick-drop'
  }]);

  assert.equal(assets.length, 1);
  assert.equal(assets[0].payload.enrichmentStatus, 'queued');
  assert.equal(assets[0].payload.manualHintUrl, 'https://manuals.example/quick-drop.pdf');
  assert.equal(assets[0].payload.manualSourceHintUrl, 'https://manuals.example/quick-drop');
  assert.equal(assets[0].payload.supportHintUrl, 'https://support.example/quick-drop');
  assert.equal(assets[0].payload.manualLibraryRef, undefined);
  assert.equal(assets[0].payload.manualStoragePath, undefined);
  assert.deepEqual(enrichCalls, ['quick-drop']);
  assert.match(state.adminUi.importSummary, /Queued for research 1\. Enrichment started 1, completed 1, failed 0/);
});



test('admin CSV import bootstrap mode attaches direct manual hints immediately and skips enrichment fallback', async () => {
  const { createAdminActions } = await loadAdminActions();
  const enrichCalls = [];
  const bootstrapCalls = [];
  const state = {
    user: { uid: 'admin-1' },
    adminUi: { importPreview: 'Preview rows' }
  };

  const actions = createAdminActions({
    state,
    render: () => {},
    refreshData: async () => {},
    runAction: async () => {},
    withRequiredCompanyId: (payload) => payload,
    upsertEntity: async () => {},
    clearEntitySet: async () => 0,
    saveAppSettings: async () => {},
    exportBackupJson: async () => ({}),
    buildAssetsCsv: () => '',
    buildTasksCsv: () => '',
    buildAuditCsv: () => '',
    buildWorkersCsv: () => '',
    buildMembersCsv: () => '',
    buildInvitesCsv: () => '',
    buildLocationsCsv: () => '',
    buildCompanyBackupBundle: () => ({}),
    downloadFile: () => {},
    downloadJson: () => {},
    normalizeAssetId: (value) => `${value || ''}`.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    enrichAssetDocumentation: async (assetId) => { enrichCalls.push(assetId); },
    bootstrapAttachAssetManualFromCsvHint: async (payload) => {
      bootstrapCalls.push(payload);
      return { attached: true };
    },
    createCompanyInvite: async () => ({}),
    revokeInvite: async () => {}
  });

  await actions.importAssets([{
    'asset name': 'Quick Drop',
    manufacturer: 'Bay Tek',
    manualHintUrl: 'https://manuals.example/quick-drop.pdf',
    manualSourceHintUrl: 'https://manuals.example/quick-drop'
  }], { bootstrapAttachManualsFromCsvHints: true });

  assert.equal(bootstrapCalls.length, 1);
  assert.equal(bootstrapCalls[0].assetId, 'quick-drop');
  assert.deepEqual(enrichCalls, []);
  assert.match(state.adminUi.importSummary, /Bootstrap attached 1, failed 0/);
  assert.match(state.adminUi.importSummary, /skipped enrichment\/research queueing/);
  assert.equal(state.adminUi.importConfig.bootstrapAttachManualsFromCsvHints, true);
  assert.equal(state.adminUi.importProgress.totalRows, 1);
  assert.equal(state.adminUi.importProgress.completedRows, 1);
  assert.equal(state.adminUi.importProgress.directManualsAttached, 1);
  assert.equal(state.adminUi.importProgress.bootstrapMode, true);
  assert.equal(state.adminUi.importProgress.isRunning, false);
});

test('admin CSV import bootstrap mode keeps processing when attach fails and does not trigger enrichment', async () => {
  const { createAdminActions } = await loadAdminActions();
  const enrichCalls = [];
  const state = {
    user: { uid: 'admin-1' },
    adminUi: { importPreview: 'Preview rows' }
  };

  const actions = createAdminActions({
    state,
    render: () => {},
    refreshData: async () => {},
    runAction: async () => {},
    withRequiredCompanyId: (payload) => payload,
    upsertEntity: async () => {},
    clearEntitySet: async () => 0,
    saveAppSettings: async () => {},
    exportBackupJson: async () => ({}),
    buildAssetsCsv: () => '',
    buildTasksCsv: () => '',
    buildAuditCsv: () => '',
    buildWorkersCsv: () => '',
    buildMembersCsv: () => '',
    buildInvitesCsv: () => '',
    buildLocationsCsv: () => '',
    buildCompanyBackupBundle: () => ({}),
    downloadFile: () => {},
    downloadJson: () => {},
    normalizeAssetId: (value) => `${value || ''}`.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    enrichAssetDocumentation: async (assetId) => { enrichCalls.push(assetId); },
    bootstrapAttachAssetManualFromCsvHint: async () => ({ attached: false, status: 'bootstrap_attach_failed_validation' }),
    createCompanyInvite: async () => ({}),
    revokeInvite: async () => {}
  });

  await actions.importAssets([{
    'asset name': 'Quick Drop',
    manufacturer: 'Bay Tek',
    manualHintUrl: 'https://manuals.example/quick-drop.pdf'
  }], { bootstrapAttachManualsFromCsvHints: true });

  assert.deepEqual(enrichCalls, []);
  assert.match(state.adminUi.importSummary, /Bootstrap attached 0, failed 1/);
  assert.match(state.adminUi.importSummary, /skipped enrichment\/research queueing/);
  assert.equal(state.adminUi.importProgress.directManualAttachFailed, 1);
});
test('admin CSV import reconciles recent intake rows from refreshed asset enrichment state', async () => {
  const { createAdminActions } = await loadAdminActions();
  const state = {
    user: { uid: 'user-1' },
    adminUi: { importPreview: '' },
    assetUi: { recentIntakeRows: [] },
    assets: []
  };
  const actions = createAdminActions({
    state,
    render: () => {},
    refreshData: async () => {
      state.assets = [{
        id: 'quick-drop',
        name: 'Quick Drop',
        manufacturer: 'Bay Tek',
        enrichmentStatus: 'deterministic-search-no-results',
        reviewState: 'pending_review'
      }];
    },
    runAction: async () => {},
    withRequiredCompanyId: (payload) => payload,
    upsertEntity: async () => {},
    clearEntitySet: async () => 0,
    saveAppSettings: async () => {},
    exportBackupJson: async () => ({}),
    buildAssetsCsv: () => '',
    buildTasksCsv: () => '',
    buildAuditCsv: () => '',
    buildWorkersCsv: () => '',
    buildMembersCsv: () => '',
    buildInvitesCsv: () => '',
    buildLocationsCsv: () => '',
    buildCompanyBackupBundle: () => ({}),
    downloadFile: () => {},
    downloadJson: () => {},
    normalizeAssetId: (value) => `${value || ''}`.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    enrichAssetDocumentation: async () => {},
    createCompanyInvite: async () => ({}),
    revokeInvite: async () => {}
  });

  await actions.importAssets([{ 'asset name': 'Quick Drop', manufacturer: 'Bay Tek' }]);

  assert.equal(state.adminUi.importConfig.bootstrapAttachManualsFromCsvHints, false);
  assert.equal(state.adminUi.importProgress.bootstrapMode, false);
  assert.equal(state.assetUi.recentIntakeRows.length, 1);
  assert.equal(state.assetUi.recentIntakeRows[0].assetId, 'quick-drop');
  assert.equal(state.assetUi.recentIntakeRows[0].intakeStatusLabel, 'no match yet');
  assert.equal(state.assetUi.recentIntakeRows[0].reviewState, 'pending_review');
});

test('admin manual text extraction scan defaults selection to repairable rows and runs per-asset repair', async () => {
  const { createAdminActions } = await loadAdminActions();
  const repairCalls = [];
  let refreshCalls = 0;
  const state = {
    company: { id: 'company-a' },
    permissions: { companyRole: 'manager', role: 'manager' },
    user: { uid: 'user-1' },
    assets: [
      { id: 'asset-a', name: 'Asset A', locationName: 'Floor', manualStatus: 'manual_attached', manualStoragePath: 'companies/company-a/manuals/asset-a/source.pdf' },
      { id: 'asset-b', name: 'Asset B', locationName: 'Floor', manualStatus: 'manual_attached', manualStoragePath: 'companies/company-a/manuals/asset-b/source.pdf' },
      { id: 'asset-c', name: 'Asset C', locationName: 'Floor', manualStatus: 'manual_attached' }
    ],
    adminUi: {}
  };
  const actions = createAdminActions({
    state,
    render: () => {},
    refreshData: async () => { refreshCalls += 1; },
    runAction: async () => {},
    withRequiredCompanyId: (payload) => payload,
    upsertEntity: async () => {},
    clearEntitySet: async () => 0,
    saveAppSettings: async () => {},
    exportBackupJson: async () => ({}),
    buildAssetsCsv: () => '',
    buildTasksCsv: () => '',
    buildAuditCsv: () => '',
    buildWorkersCsv: () => '',
    buildMembersCsv: () => '',
    buildInvitesCsv: () => '',
    buildLocationsCsv: () => '',
    buildCompanyBackupBundle: () => ({}),
    downloadFile: () => {},
    downloadJson: () => {},
    normalizeAssetId: (value) => value,
    enrichAssetDocumentation: async () => {},
    repairAssetDocumentationState: async (payload) => {
      repairCalls.push(payload);
      if (payload.dryRun) {
        return {
          manualMaterialization: {
            entries: [
              { assetId: 'asset-a', action: 'would_materialize', reason: 'dry_run_materialization_planned', extractionStatus: 'skipped', extractionReason: 'storage_path_missing', priorExtractionStatus: 'unknown', priorChunkCount: 0 },
              { assetId: 'asset-b', action: 'already_has_chunks', reason: 'already_has_chunks', extractionStatus: 'already_has_chunks', extractionReason: 'already_has_chunks', priorExtractionStatus: 'completed', priorChunkCount: 8 },
              { assetId: 'asset-c', action: 'no_manual_storage_path', reason: 'storage_path_missing', extractionStatus: 'storage_object_missing', extractionReason: 'storage_object_not_found', priorExtractionStatus: 'unknown', priorChunkCount: 0 }
            ]
          }
        };
      }
      return { manualMaterialization: { entries: [{ assetId: payload.assetId, action: 'materialized', newChunkCount: 6, newExtractionStatus: 'completed', extractionStatus: 'completed', extractionReason: 'text_extracted' }] } };
    },
    createCompanyInvite: async () => ({}),
    revokeInvite: async () => {}
  });

  await actions.checkManualTextExtraction({ limit: 100 });
  assert.deepEqual(repairCalls[0], { companyId: 'company-a', dryRun: true, limit: 100 });
  assert.deepEqual(state.adminUi.manualRepairSelectedAssetIds, ['asset-a']);

  actions.selectAllManualRepairRows();
  assert.deepEqual(state.adminUi.manualRepairSelectedAssetIds, ['asset-a']);
  actions.clearManualRepairSelection();
  assert.deepEqual(state.adminUi.manualRepairSelectedAssetIds, []);

  await actions.runManualRepairForSelection({ assetIds: ['asset-a'], concurrency: 2 });
  assert.deepEqual(repairCalls.slice(1), [{ assetId: 'asset-a', companyId: 'company-a', dryRun: false }]);
  assert.equal(refreshCalls, 1);
  assert.match(state.adminUi.manualRepairMessage, /Manual text repair complete/);
});

test('admin source includes manual text extraction repair card and user-facing status labels', () => {
  const source = loadAdminSource();
  assert.match(source, /Manual text extraction repair/);
  assert.match(source, /data-manual-repair-check/);
  assert.match(source, /data-manual-repair-run/);
  assert.match(source, /No readable text/);
  assert.match(source, /Unsupported file/);
  assert.match(source, /Missing file/);
  assert.match(source, /Extracted/);
  assert.match(source, /Download repair results CSV/);
  assert.match(source, /Already has text/);
  assert.match(source, /Need extraction:/);
  assert.match(source, /const canRunManualRepair = isManager\(state.permissions\)/);
});

test('admin source keeps bootstrap checkbox and mode text tied to import config and progress state', () => {
  const source = loadAdminSource();
  assert.match(source, /const bootstrapModeActive = importProgress\?\.isRunning/);
  assert.match(source, /id="bootstrapAttachManualsFromCsvHints" type="checkbox" \$\{bootstrapModeActive \? 'checked' : ''\} \$\{importProgress\?\.isRunning \? 'disabled' : ''\}/);
  assert.match(source, /mode locked while import is running/);
  assert.match(source, /Mode: direct CSV bootstrap/);
  const captureIndex = source.indexOf("const bootstrapAttachManualsFromCsvHints = el.querySelector('#bootstrapAttachManualsFromCsvHints')?.checked === true;");
  const previewIndex = source.indexOf("actions.setImportFeedback({ tone: rows.length ? 'info' : 'error'");
  assert.ok(captureIndex >= 0 && previewIndex >= 0 && captureIndex < previewIndex);
});

test('admin source no longer exposes a duplicate asset documentation review section', () => {
  const source = loadAdminSource();
  assert.doesNotMatch(source, /asset_review/);
  assert.doesNotMatch(source, /Asset documentation review/);
  assert.doesNotMatch(source, /data-run-review-enrichment/);
});


test('operations AI run selection prefers current completed run over older answered follow-up-required run', async () => {
  const { __testOperationsAi } = await loadOperationsHelpers();
  const task = {
    id: 'task-1',
    companyId: 'company-a',
    currentAiRunId: 'run-new',
    aiStatus: 'completed',
    aiLastCompletedRunSnapshot: { runId: 'run-new', taskId: 'task-1', companyId: 'company-a', completedAt: '2026-03-20T00:00:00.000Z', frontline: 'Use balloon refill steps.' }
  };
  const state = {
    settings: { aiEnabled: true, aiAllowManualRerun: true },
    permissions: { companyRole: 'lead' },
    operationsUi: { aiTaskStates: {}, aiDisplayRunsByTask: {} },
    taskAiRuns: [
      { id: 'run-old', taskId: 'task-1', companyId: 'company-a', status: 'followup_required', followupStatus: 'answered', continuedByRunId: 'run-new', updatedAt: '2026-03-19T00:00:00.000Z' },
      { id: 'run-new', taskId: 'task-1', companyId: 'company-a', status: 'completed', updatedAt: '2026-03-20T00:00:00.000Z', shortFrontlineVersion: 'E10 indicates out of balloons.', diagnosticSteps: ['Refill balloons'] }
    ],
    taskAiFollowups: [
      { runId: 'run-old', status: 'answered', questions: ['What code?'], answers: [{ question: 'What code?', answer: 'E10' }] }
    ]
  };

  const run = __testOperationsAi.getTaskRun(task, state);
  assert.equal(run.id, 'run-new');
  const followup = __testOperationsAi.getTaskFollowup(run.id, state, run, task);
  assert.equal(followup, null);
});

test('operations AI follow-up rendering hides blocker for answered follow-up docs', async () => {
  const { __testOperationsAi } = await loadOperationsHelpers();
  const task = {
    id: 'task-2',
    companyId: 'company-a',
    currentAiRunId: 'run-2',
    aiStatus: 'completed',
    aiLastCompletedRunSnapshot: { runId: 'run-2', taskId: 'task-2', companyId: 'company-a', completedAt: '2026-03-20T00:00:00.000Z', frontline: 'Balloon hopper empty.' }
  };
  const state = {
    settings: { aiEnabled: true, aiAllowManualRerun: true },
    permissions: { companyRole: 'lead' },
    operationsUi: { aiTaskStates: {}, aiDisplayRunsByTask: {}, pendingActionsByTask: {} },
    taskAiRuns: [
      { id: 'run-2', taskId: 'task-2', companyId: 'company-a', status: 'followup_required', followupStatus: 'answered', continuedByRunId: 'run-3', updatedAt: '2026-03-19T00:00:00.000Z' }
    ],
    taskAiFollowups: [
      { runId: 'run-2', status: 'answered', questions: ['Error code?'], answers: [{ question: 'Error code?', answer: 'E10' }] }
    ]
  };

  const run = __testOperationsAi.getTaskRun(task, state);
  const followup = __testOperationsAi.getTaskFollowup(run.id, state, run, task);
  const snapshot = __testOperationsAi.getTaskAiSnapshot(task, run);
  const aiState = __testOperationsAi.getTaskAiState(task, state, run, followup, snapshot);
  const html = __testOperationsAi.renderAiPanel(task, state, { run, followup, snapshot, aiState });

  assert.equal(followup, null);
  assert.equal(aiState.status, 'waiting_for_refresh');
  assert.equal(html.includes('cannot advance until the follow-up answers below are submitted'), false);
});

test('operations AI source hint explains missing extracted manual text for manual/link-backed mode', async () => {
  const { __testOperationsAi } = await loadOperationsHelpers();
  const task = {
    id: 'task-3',
    companyId: 'company-a',
    aiStatus: 'completed',
    aiLastCompletedRunSnapshot: { runId: 'run-3', taskId: 'task-3', companyId: 'company-a', completedAt: '2026-03-21T00:00:00.000Z', documentationMode: 'manual_backed', manualChunkCount: 0, documentationTextAvailable: false, frontline: 'Check hopper.' }
  };
  const state = {
    settings: { aiEnabled: true, aiAllowManualRerun: true },
    permissions: { companyRole: 'lead' },
    operationsUi: { aiTaskStates: {}, aiDisplayRunsByTask: {} },
    taskAiRuns: [],
    taskAiFollowups: []
  };

  const run = __testOperationsAi.getTaskRun(task, state);
  const snapshot = __testOperationsAi.getTaskAiSnapshot(task, run);
  const aiState = __testOperationsAi.getTaskAiState(task, state, run, null, snapshot);
  const html = __testOperationsAi.renderAiPanel(task, state, { run, followup: null, snapshot, aiState });

  assert.match(html, /Manual is attached, but extracted manual text is not available yet/);
});

test('operations AI panel renders evidence table with manual code definition excerpts', async () => {
  const { __testOperationsAi } = await loadOperationsHelpers();
  const task = {
    id: 'task-4',
    companyId: 'company-a',
    aiStatus: 'completed',
    aiLastCompletedRunSnapshot: { runId: 'run-4', taskId: 'task-4', companyId: 'company-a', completedAt: '2026-03-21T00:00:00.000Z', frontline: 'Use manual code definition.', documentationSources: [{ sourceType: 'approved_manual_code_definition', matchedCodes: ['E11'], title: 'Manual', excerpts: ['ERROR 11 — CARD DISPENSER ERROR'], confidence: 0.95 }] }
  };
  const run = {
    id: 'run-4',
    taskId: 'task-4',
    companyId: 'company-a',
    status: 'completed',
    shortFrontlineVersion: 'Use manual code definition.',
    documentationSources: [{ sourceType: 'approved_manual_code_definition', matchedCodes: ['E11'], title: 'Manual', excerpts: ['ERROR 11 — CARD DISPENSER ERROR'], confidence: 0.95 }]
  };
  const state = {
    settings: { aiEnabled: true, aiUseWebSearch: true },
    permissions: { companyRole: 'lead' },
    operationsUi: { aiTaskStates: {}, aiDisplayRunsByTask: {} },
    taskAiRuns: [run],
    taskAiFollowups: []
  };
  const snapshot = __testOperationsAi.getTaskAiSnapshot(task, run);
  const aiState = __testOperationsAi.getTaskAiState(task, state, run, null, snapshot);
  const html = __testOperationsAi.renderAiPanel(task, state, { run, followup: null, snapshot, aiState });
  assert.match(html, /AI evidence used/);
  assert.match(html, /Manual code definition/);
  assert.match(html, /E11/);
  assert.match(html, /ERROR 11[\s\S]*CARD DISPENSER ERROR/);
});

test('operations AI evidence table truncates long manual excerpts with disclosure and prioritizes code definitions', async () => {
  const { __testOperationsAi } = await loadOperationsHelpers();
  const longExcerpt = `${'Long manual chunk text '.repeat(40)}ERROR 11 CARD DISPENSER ERROR`;
  const run = {
    id: 'run-6',
    taskId: 'task-6',
    companyId: 'company-a',
    status: 'completed',
    documentationSources: [
      { sourceType: 'approved_manual_chunk', matchedCodes: [], title: 'Manual chunk', excerpts: [longExcerpt] },
      { sourceType: 'approved_manual_code_definition', matchedCodes: ['E11'], title: 'Manual code row', excerpts: ['ERROR 11 — CARD DISPENSER ERROR — CARD EMPTY IN THE DISPENSER. AFTER TAKING ACTION, PRESS RESET BUTTON.'], confidence: 0.95 }
    ]
  };
  const task = { id: 'task-6', companyId: 'company-a', aiStatus: 'completed', aiLastCompletedRunSnapshot: { runId: 'run-6', taskId: 'task-6', companyId: 'company-a', completedAt: '2026-03-21T00:00:00.000Z' } };
  const state = {
    settings: { aiEnabled: true, aiUseWebSearch: false },
    permissions: { companyRole: 'lead' },
    operationsUi: { aiTaskStates: {}, aiDisplayRunsByTask: {} },
    taskAiRuns: [run],
    taskAiFollowups: []
  };
  const snapshot = __testOperationsAi.getTaskAiSnapshot(task, run);
  const aiState = __testOperationsAi.getTaskAiState(task, state, run, null, snapshot);
  const html = __testOperationsAi.renderAiPanel(task, state, { run, followup: null, snapshot, aiState });
  assert.match(html, /Show full excerpt/);
  assert.match(html, /Manual code definition/);
  assert.equal(html.indexOf('Manual code definition') < html.indexOf('Manual text excerpt'), true);
});

test('operations AI panel labels saved guidance from previous run when showing snapshot', async () => {
  const { __testOperationsAi } = await loadOperationsHelpers();
  const task = {
    id: 'task-7',
    companyId: 'company-a',
    aiStatus: 'completed',
    aiLastCompletedRunSnapshot: { runId: 'run-old', taskId: 'task-7', companyId: 'company-a', completedAt: '2026-03-20T00:00:00.000Z' }
  };
  const state = {
    settings: { aiEnabled: true, aiAllowManualRerun: true },
    permissions: { companyRole: 'lead' },
    operationsUi: { aiTaskStates: {}, aiDisplayRunsByTask: {} },
    taskAiRuns: [{ id: 'run-new', taskId: 'task-7', companyId: 'company-a', status: 'running', updatedAt: '2026-03-21T00:00:00.000Z' }],
    taskAiFollowups: []
  };
  const snapshot = __testOperationsAi.getTaskAiSnapshot(task, null);
  const aiState = __testOperationsAi.getTaskAiState(task, state, null, null, snapshot);
  const html = __testOperationsAi.renderAiPanel(task, state, { run: null, followup: null, snapshot, aiState });
  assert.match(html, /Saved guidance from previous run/);
  assert.match(html, /newer AI run is currently in progress/i);
});

test('operations AI panel renders web research not configured status when applicable', async () => {
  const { __testOperationsAi } = await loadOperationsHelpers();
  const task = { id: 'task-5', companyId: 'company-a', aiStatus: 'completed', aiLastCompletedRunSnapshot: { runId: 'run-5', taskId: 'task-5', companyId: 'company-a', completedAt: '2026-03-21T00:00:00.000Z' } };
  const run = {
    id: 'run-5',
    taskId: 'task-5',
    companyId: 'company-a',
    status: 'completed',
    webContextSummary: 'Web research is not configured. AI is using manuals/internal data only.',
    documentationSources: []
  };
  const state = {
    settings: { aiEnabled: true, aiUseWebSearch: true },
    permissions: { companyRole: 'lead' },
    operationsUi: { aiTaskStates: {}, aiDisplayRunsByTask: {} },
    taskAiRuns: [run],
    taskAiFollowups: []
  };
  const snapshot = __testOperationsAi.getTaskAiSnapshot(task, run);
  const aiState = __testOperationsAi.getTaskAiState(task, state, run, null, snapshot);
  const html = __testOperationsAi.renderAiPanel(task, state, { run, followup: null, snapshot, aiState });
  assert.match(html, /Web research is not configured\. AI is using manuals\/internal data only\./);
});

test('operations source includes explicit create-task loading and error states', () => {
  const source = loadOperationsSource();
  assert.match(source, /creatingTask/);
  assert.match(source, /createTaskMessage/);
  assert.match(source, /createTaskError/);
  assert.match(source, /Creating task & starting AI/);
  assert.match(source, /await actions\.saveTask\(payload\.id \|\| `\$\{fd\.get\('id'\) \|\| ''\}`\.trim\(\), payload\)/);
});

test('operations source includes task type and checklist scaffolding with optional asset handling', () => {
  const source = loadOperationsSource();
  assert.match(source, /data-task-type-card/);
  assert.match(source, /Repair Task/);
  assert.match(source, /General Task/);
  assert.match(source, /opening_checklist/);
  assert.match(source, /closing_checklist/);
  assert.match(source, /upkeep_checklist/);
  assert.match(source, /Checklist builder/);
  assert.match(source, /name="checklistItemsInput"/);
  assert.match(source, /const needsAsset = taskType === 'asset' \|\| taskType === 'preventive_maintenance'/);
  assert.match(source, /payload\.checklistItems = normalizeChecklistItems/);
});

test('operations source includes interactive checklist controls for checklist-style tasks', () => {
  const source = loadOperationsSource();
  assert.match(source, /function isChecklistStyleTask/);
  assert.match(source, /opening_checklist/);
  assert.match(source, /closing_checklist/);
  assert.match(source, /upkeep_checklist/);
  assert.match(source, /\['preventive_maintenance', 'general'\]/);
  assert.match(source, /data-checklist-toggle="\$\{task\.id\}"/);
});

test('operations source checklist toggle sets and clears completion metadata', () => {
  const source = loadOperationsSource();
  assert.match(source, /completedAt: completed \? nowIso : null/);
  assert.match(source, /completedBy: completed \? completedBy : null/);
  assert.match(source, /workerId: completed \? \(item\.workerId \|\| state\.user\?\.uid \|\| null\) : null/);
  assert.match(source, /await actions\.saveTask\(task\.id, \{/);
});

test('operations source keeps checklist rendering optional and asset behavior intact', () => {
  const source = loadOperationsSource();
  assert.match(source, /renderChecklist\(task, editable\)/);
  assert.match(source, /if \(!items\.length\) return '';/);
  assert.match(source, /const needsAsset = taskType === 'asset' \|\| taskType === 'preventive_maintenance'/);
});


test('assets source renders technical identity details and mismatch note', () => {
  const source = loadAssetsSource();
  assert.match(source, /Firestore id:/);
  assert.match(source, /Stored id:/);
  assert.match(source, /Asset record id:/);
  assert.match(source, /Company id:/);
  assert.match(source, /Identity check: Firestore id and stored id differ/);
});

test('assets source uses tabbed layout with asset records default and section separation', () => {
  const source = loadAssetsSource();
  assert.match(source, /data-assets-tab="asset_records"/);
  assert.match(source, /data-assets-tab="documentation_review"/);
  assert.match(source, /data-assets-tab="add_asset"/);
  assert.match(source, /activeAssetsTab === 'asset_records'/);
  assert.match(source, /activeAssetsTab === 'documentation_review'/);
  assert.match(source, /activeAssetsTab === 'add_asset'/);
  assert.match(source, /<b>Manual review queue<\/b>/);
  assert.doesNotMatch(source, /<b>Research Titles<\/b>/);
  assert.match(source, /Manual asset form/);
  assert.match(source, /Bulk import moved to <b>Admin → Bulk import<\/b>/);
});

test('assets source includes manual attach controls and upload actions', () => {
  const source = loadAssetsSource();
  assert.match(source, /Attach manual/);
  assert.match(source, /data-manual-attach-section/);
  assert.match(source, /data-asset-id="\$\{asset\.id\}"/);
  assert.match(source, /data-attach-manual-url/);
  assert.match(source, /data-manual-url-input/);
  assert.match(source, /data-manual-title-input/);
  assert.match(source, /data-manual-file-input/);
  assert.match(source, /data-upload-manual-file/);
  assert.match(source, /Upload and extract manual/);
});

test('data source preserves canonical firestore asset id metadata', () => {
  const source = loadDataSource();
  assert.match(source, /toCanonicalAssetRecord/);
  assert.match(source, /firestoreDocId: snap\.id/);
  assert.match(source, /storedAssetId/);
});

test('data source keeps company invites durable with missing-index fallback query path', () => {
  const source = loadDataSource();
  assert.match(source, /\[people_invites\] Falling back to non-ordered Firestore query due to missing index/);
  assert.match(source, /buildFallbackScopeQuery/);
  assert.match(source, /\.sort\(\(a, b\) => \{/);
});


test('admin invite action stores worker profile metadata on invite creation', async () => {
  const { createAdminActions } = await loadAdminActions();
  const inviteCalls = [];
  const state = {
    company: { id: 'co-1' },
    user: { uid: 'admin-1' },
    invites: [],
    adminUi: {}
  };
  const actions = createAdminActions({
    state,
    render: () => {},
    refreshData: async () => {},
    runAction: async (_label, fn) => fn(),
    withRequiredCompanyId: (payload) => payload,
    upsertEntity: async () => {},
    clearEntitySet: async () => 0,
    saveAppSettings: async () => {},
    exportBackupJson: async () => ({}),
    buildAssetsCsv: () => '',
    buildTasksCsv: () => '',
    buildAuditCsv: () => '',
    buildWorkersCsv: () => '',
    buildMembersCsv: () => '',
    buildInvitesCsv: () => '',
    buildLocationsCsv: () => '',
    buildCompanyBackupBundle: () => ({}),
    downloadFile: () => {},
    downloadJson: () => {},
    normalizeAssetId: (value) => value,
    enrichAssetDocumentation: async () => {},
    createCompanyInvite: async (payload) => {
      inviteCalls.push(payload);
      return {
        id: 'inv-1',
        inviteCode: 'ABC1234XYZ',
        token: 'token-1',
        invite: {
          id: 'inv-1',
          companyId: 'co-1',
          email: 'taylor@example.com',
          role: 'staff',
          displayName: 'Taylor Tech',
          inviteCode: 'ABC1234XYZ',
          inviteCodeNormalized: 'ABC1234XYZ',
          status: 'pending',
          createWorkerProfile: true,
          workerTitle: 'Field Tech',
          workerNotes: 'Night shift'
        }
      };
    },
    revokeInvite: async () => {}
  });

  await actions.createInvite({
    name: 'Taylor Tech',
    email: 'Taylor@example.com',
    role: 'staff',
    createWorkerProfile: 'on',
    workerTitle: 'Field Tech',
    workerNotes: 'Night shift'
  });

  assert.equal(inviteCalls.length, 1);
  assert.equal(inviteCalls[0].createWorkerProfile, true);
  assert.equal(inviteCalls[0].workerTitle, 'Field Tech');
  assert.equal(inviteCalls[0].workerNotes, 'Night shift');
  assert.equal(state.invites[0].inviteCode, 'ABC1234XYZ');
  assert.equal(state.invites[0].inviteCodeNormalized, 'ABC1234XYZ');
  assert.equal(state.invites[0].status, 'pending');
});

test('admin invite action surfaces permission diagnostics on denied callable response', async () => {
  const { createAdminActions } = await loadAdminActions();
  const state = {
    company: { id: 'co-1' },
    user: { uid: 'admin-1' },
    companyMembers: [{ id: 'co-1_admin-1', userId: 'admin-1', role: 'manager', status: 'inactive' }],
    permissions: { companyRole: 'manager' },
    invites: [],
    adminUi: {}
  };
  const actions = createAdminActions({
    state,
    render: () => {},
    refreshData: async () => {},
    runAction: async (_label, fn) => fn(),
    withRequiredCompanyId: (payload) => payload,
    upsertEntity: async () => {},
    clearEntitySet: async () => 0,
    saveAppSettings: async () => {},
    exportBackupJson: async () => ({}),
    buildAssetsCsv: () => '',
    buildTasksCsv: () => '',
    buildAuditCsv: () => '',
    buildWorkersCsv: () => '',
    buildMembersCsv: () => '',
    buildInvitesCsv: () => '',
    buildLocationsCsv: () => '',
    buildCompanyBackupBundle: () => ({}),
    downloadFile: () => {},
    downloadJson: () => {},
    normalizeAssetId: (value) => value,
    enrichAssetDocumentation: async () => {},
    createCompanyInvite: async () => {
      const error = new Error('permission denied');
      error.code = 'permission-denied';
      throw error;
    },
    revokeInvite: async () => {}
  });

  await assert.rejects(() => actions.createInvite({
    name: 'Taylor Tech',
    email: 'Taylor@example.com',
    role: 'staff'
  }));
  assert.match(state.adminUi.message, /Invite could not be created\. Your current membership is missing, inactive, or does not have People management access\./);
  assert.match(state.adminUi.message, /uid=admin-1, companyId=co-1, role=manager, status=inactive/);
});

test('people rows keep pending invite entries visible even without linked member, worker, or email', async () => {
  const source = loadAdminSource();
  assert.match(source, /const pendingInvites = invites\.filter\(\(invite\) => `\$\{invite\?\.status \|\| ''\}`\.trim\(\)\.toLowerCase\(\) === 'pending'\);/);
  assert.match(source, /pendingInvites\.forEach\(\(invite\) => \{/);
  assert.match(source, /id: `pending-invite-\$\{inviteId\}`,/);
  assert.match(source, /if \(!inviteId \|\| rows\.some\(\(row\) => row\.invite\?\.id === inviteId\)\) return;/);
  assert.match(source, /Pending invites \(\$\{pendingInviteRows\.length\}\)/);
  assert.match(source, /pendingInviteRows\.map\(\(invite\) => \{/);
  assert.match(source, /data-copy-invite-message/);
  assert.match(source, /Invites with failed attempts:/);
  assert.match(source, /data-disable-member-access/);
  assert.match(source, /data-reactivate-member-access/);
  assert.match(source, /data-remove-member-access/);
  assert.match(source, /failed attempts:/);
});

test('admin people section clarifies membership access controls and not Firebase Auth deletion', async () => {
  const source = loadAdminSource();
  assert.match(source, /workspace access controls and do not delete the user from Firebase Auth/);
});

test('admin actions block self-disable and self-remove for current owner/admin session', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'features', 'adminActions.js'), 'utf8');
  assert.match(source, /You cannot disable or remove your own access\./);
  assert.match(source, /Owner access cannot be changed here\./);
});

test('admin people password reset action uses auth reset helper and updates UI state', async () => {
  const { createAdminActions } = await loadAdminActions();
  const calls = [];
  const state = {
    adminUi: {}
  };
  const actions = createAdminActions({
    state,
    render: () => {},
    refreshData: async () => {},
    runAction: async (_label, fn) => fn(),
    withRequiredCompanyId: (payload) => payload,
    upsertEntity: async () => {},
    clearEntitySet: async () => 0,
    saveAppSettings: async () => {},
    exportBackupJson: async () => ({}),
    buildAssetsCsv: () => '',
    buildTasksCsv: () => '',
    buildAuditCsv: () => '',
    buildWorkersCsv: () => '',
    buildMembersCsv: () => '',
    buildInvitesCsv: () => '',
    buildLocationsCsv: () => '',
    buildCompanyBackupBundle: () => ({}),
    downloadFile: () => {},
    downloadJson: () => {},
    normalizeAssetId: (value) => value,
    enrichAssetDocumentation: async () => {},
    createCompanyInvite: async () => ({}),
    revokeInvite: async () => {},
    sendForgotPasswordEmail: async (email) => { calls.push(email); }
  });

  await actions.sendPersonPasswordReset('person@example.com');

  assert.deepEqual(calls, ['person@example.com']);
  assert.equal(state.adminUi.passwordResetByEmail['person@example.com'], 'success');
});
