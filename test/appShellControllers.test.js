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

async function loadAssetDraftContextHelpers() {
  return import('../src/features/assetDraftContext.js');
}

async function loadAssetActions() {
  return import('../src/features/assetActions.js');
}

async function loadManufacturerNormalizationHelpers() {
  return import('../src/features/manufacturerNormalization.js');
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
  assert.equal(fallback.hasAttachedManual, true);
  assert.deepEqual(fallback.manualLinks, ['https://example.com/manual.pdf']);
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
    manualStatus: 'no_manual',
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
  assert.equal(adminSection, 'invites');

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
  assert.equal(row.manualUrl, 'https://www.betson.com/wp-content/uploads/2018/03/quik-drop-service-manual.pdf');
  assert.equal(row.manualSourceUrl, 'https://www.baytekent.com/games/quik-drop/');
  assert.equal(row.supportUrl, 'https://www.baytekent.com/games/quik-drop/');
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
  assert.equal(row.supportUrl, 'https://rawthrills.com/service/');
  assert.equal(row.manualUrl, '');
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

test('asset and admin enrichment surfaces share the same manual trigger request and approval helper', async () => {
  const {
    approveSuggestedManualSources,
    buildFollowupEnrichmentRequest,
    buildManualEnrichmentRequest
  } = await loadAssetEnrichmentPipeline();

  assert.deepEqual(buildManualEnrichmentRequest(), { trigger: 'manual' });
  assert.deepEqual(buildFollowupEnrichmentRequest('  exact subtitle  '), {
    trigger: 'followup_answer',
    followupAnswer: 'exact subtitle'
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
  assert.deepEqual(singlePatch.manualLinks, ['https://www.betson.com/wp-content/uploads/2018/03/quik-drop-service-manual.pdf']);
  assert.deepEqual(bulkPatch.manualLinks, reviewable.map((entry) => entry.url));
  assert.equal(singlePatch.reviewState, 'approved');
  assert.equal(bulkPatch.reviewState, 'approved');
  assert.equal(singlePatch.manualStatus, 'attached');
  assert.equal(bulkPatch.manualStatus, 'attached');
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

test('asset csv parser remains backward compatible and accepts optional enrichment columns', async () => {
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
  assert.equal(enriched.rows[0].manualUrl, 'https://manual.example/jp.pdf');
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
  assert.equal(rows[0].manualUrl, 'https://manuals.example/quick-drop.pdf');
  assert.equal(rows[0].supportEmail, 'support@example.com');
  assert.match(buildAssetCsv(rows), /originalTitle,normalizedTitle,manufacturerInferred,manualUrl,manualSourceUrl,supportUrl,supportEmail/);
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


test('asset manual status derivation distinguishes attached vs support-only vs review-needed vs none', async () => {
  const { deriveAssetManualStatus } = await import('./../src/features/assets.js');
  assert.equal(deriveAssetManualStatus({ manualLibraryRef: 'manual-1', manualLinks: [] }), 'attached');
  assert.equal(deriveAssetManualStatus({ documentationSuggestions: [{ url: 'https://example.com/manual.pdf', verified: true, exactTitleMatch: true, exactManualMatch: true }] }), 'review_needed');
  assert.equal(deriveAssetManualStatus({ supportResourcesSuggestion: [{ url: 'https://example.com/support', label: 'Support' }] }), 'support_only');
  assert.equal(deriveAssetManualStatus({ documentationSuggestions: [], supportResourcesSuggestion: [] }), 'no_manual');
});

test('asset helpers render manual outcome states consistently', async () => {
  const { deriveAssetManualStatus, getEffectiveEnrichmentStatus } = await import('./../src/features/assets.js');
  assert.equal(deriveAssetManualStatus({ manualLibraryRef: 'manual-1', manualLinks: [] }), 'attached');
  assert.equal(getEffectiveEnrichmentStatus({ manualStatus: 'attached', enrichmentStatus: 'in_progress', manualLibraryRef: 'manual-1' }), 'verified_manual_found');
  assert.equal(deriveAssetManualStatus({ manualStatus: 'support_only', supportResourcesSuggestion: [{ url: 'https://example.com/support', label: 'Support' }] }), 'support_only');
  assert.equal(getEffectiveEnrichmentStatus({
    manualStatus: 'support_only',
    enrichmentStatus: 'in_progress',
    supportResourcesSuggestion: [{ url: 'https://example.com/support', label: 'Support' }],
    enrichmentRequestedAt: new Date(Date.now() - (5 * 60 * 1000)).toISOString(),
    enrichmentHeartbeatAt: new Date(Date.now() - (4 * 60 * 1000)).toISOString(),
  }), 'followup_needed');
  assert.equal(deriveAssetManualStatus({ documentationSuggestions: [{ url: 'https://example.com/manual.pdf', verified: true, exactTitleMatch: true, exactManualMatch: true }] }), 'review_needed');
  assert.equal(getEffectiveEnrichmentStatus({
    manualStatus: 'review_needed',
    enrichmentStatus: 'searching_docs',
    documentationSuggestions: [{ url: 'https://example.com/manual.pdf', verified: true, exactTitleMatch: true, exactManualMatch: true }],
    enrichmentRequestedAt: new Date(Date.now() - (5 * 60 * 1000)).toISOString(),
    enrichmentHeartbeatAt: new Date(Date.now() - (4 * 60 * 1000)).toISOString(),
  }), 'followup_needed');
  assert.equal(deriveAssetManualStatus({ manualStatus: 'no_manual', documentationSuggestions: [], supportResourcesSuggestion: [] }), 'no_manual');
  assert.equal(getEffectiveEnrichmentStatus({
    manualStatus: 'no_manual',
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

test('admin source no longer exposes a duplicate asset documentation review section', () => {
  const source = loadAdminSource();
  assert.doesNotMatch(source, /asset_review/);
  assert.doesNotMatch(source, /Asset documentation review/);
  assert.doesNotMatch(source, /data-run-review-enrichment/);
});
