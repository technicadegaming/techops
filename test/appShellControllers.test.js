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


async function loadDocumentationReviewHelpers() {
  return import('../src/features/documentationReview.js');
}

async function loadAssetEnrichmentPipeline() {
  return import('../src/features/assetEnrichmentPipeline.js');
}


async function loadAssetIntakeHelpers() {
  return import('../src/features/assetIntake.js');
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
        verificationKind: 'support_html'
      },
      {
        title: 'Quik Drop Service Manual PDF',
        url: 'https://www.betson.com/wp-content/uploads/2018/03/quik-drop-service-manual.pdf',
        sourceType: 'distributor',
        verified: true,
        exactTitleMatch: true,
        exactManualMatch: true,
        trustedSource: true,
        matchScore: 96
      },
      {
        title: 'Virtual Rabbids: The Big Ride Install Guide PDF',
        url: 'https://laigames.com/downloads/virtual-rabbids-the-big-ride-install-guide.pdf',
        sourceType: 'manufacturer',
        verified: true,
        exactTitleMatch: true,
        exactManualMatch: true,
        trustedSource: true,
        matchScore: 92
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

  const enriched = parseAssetCsv(`asset name,assetId,manufacturer,manualUrl,manualSourceUrl,supportEmail,supportPhone,supportUrl,matchConfidence,matchNotes
Jurassic Park,jp-01,Raw Thrills,https://manual.example/jp.pdf,https://source.example/jp,support@example.com,555-1111,https://support.example/jp,0.91,Official page`);
  assert.equal(enriched.errors.length, 0);
  assert.equal(enriched.rows[0].assetId, 'jp-01');
  assert.equal(enriched.rows[0].manualUrl, 'https://manual.example/jp.pdf');
  assert.equal(enriched.rows[0].supportEmail, 'support@example.com');
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
  assert.match(buildAssetCsv(rows), /manualUrl,manualSourceUrl,supportEmail/);
});
