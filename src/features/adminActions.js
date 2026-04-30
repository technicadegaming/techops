import { buildUsageSummary, normalizeBillingAddress } from '../billing.js';
import { ASSET_CSV_TEMPLATE, buildAssetImportRow } from './assetIntake.js';
import { isManager } from '../roles.js';
import { getWorkspaceReadiness } from './workspaceReadiness.js';

export function createAdminActions(deps) {
  const {
    state,
    render,
    refreshData,
    runAction,
    withRequiredCompanyId,
    upsertEntity,
    deleteEntity,
    clearEntitySet,
    saveAppSettings,
    exportBackupJson,
    buildAssetsCsv,
    buildTasksCsv,
    buildAuditCsv,
    buildWorkersCsv,
    buildMembersCsv,
    buildInvitesCsv,
    buildLocationsCsv,
    buildCompanyBackupBundle,
    downloadFile,
    downloadJson,
    normalizeAssetId,
    enrichAssetDocumentation,
    repairAssetDocumentationState,
    bootstrapAttachAssetManualFromCsvHint,
    createCompanyInvite,
    revokeInvite,
    setWorkerLocationPin,
    sendForgotPasswordEmail,
    withGlobalBusy,
    storage,
    storageRef,
    uploadBytes,
    getDownloadURL,
    buildCompanyBrandingLogoPath
  } = deps;

  const setAdminFeedback = ({ tone = 'info', message = '' } = {}) => {
    state.adminUi = { ...(state.adminUi || {}), tone, message };
  };

  const safeWithGlobalBusy = typeof withGlobalBusy === 'function'
    ? withGlobalBusy
    : async (_title, _detail, fn) => fn();
  const buildSafeLogoFileName = (name = 'logo') => `${name || 'logo'}`
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/(^[.-]+|[.-]+$)/g, '')
    .slice(0, 96) || 'logo';

  const setImportFeedback = ({ tone = 'info', summary = '', preview = '', progress = null } = {}) => {
    state.adminUi = { ...(state.adminUi || {}), importTone: tone, importSummary: summary, importPreview: preview, importProgress: progress };
    render();
  };
  const normalizeStatusKey = (value = '') => `${value || ''}`.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const STATUS_LABELS = {
    queued: 'queued',
    searching_docs: 'searching',
    in_progress: 'searching',
    docs_found: 'docs found / attached',
    verified_manual_found: 'docs found / attached',
    followup_needed: 'follow-up needed',
    no_match_yet: 'no match yet',
    imported_no_direct_manual: 'imported (no direct manual URL)',
    imported_manual_attach_failed: 'imported (manual attach failed)',
    deterministic_search_no_results: 'no match yet',
    title_page_found_manual_probe_failed: 'follow-up needed',
    idle: 'not started'
  };
  const mapRowStatusFromAsset = (asset = {}) => {
    const status = normalizeStatusKey(asset?.enrichmentStatus || 'idle') || 'idle';
    const badge = ['searching_docs', 'in_progress'].includes(status) ? 'searching' : (status === 'queued' ? 'queued' : status);
    return {
      intakeStatusBadge: badge,
      intakeStatusLabel: STATUS_LABELS[status] || status.replace(/_/g, ' '),
      enrichmentStatus: asset?.enrichmentStatus || 'idle',
      reviewState: asset?.reviewState || '',
      manualReviewState: asset?.manualReviewState || ''
    };
  };
  const canRunManualRepair = () => isManager(state.permissions) && typeof repairAssetDocumentationState === 'function';
  const getMemberById = (id) => (state.companyMembers || []).find((member) => member.id === id);
  const isCurrentUserMembership = (member) => `${member?.userId || ''}`.trim() === `${state.user?.uid || ''}`.trim();
  const canManageMembershipAccess = (member) => {
    if (!member) return { ok: false, reason: 'Member record not found.' };
    if ((member.role || '') === 'owner') return { ok: false, reason: 'Owner access cannot be changed here.' };
    if (isCurrentUserMembership(member)) return { ok: false, reason: 'You cannot disable or remove your own access.' };
    return { ok: true, reason: '' };
  };
  const MANUAL_REPAIRABLE_ACTIONS = new Set(['would_materialize', 'would_reextract']);
  const getRepairableAssetIds = (rows = []) => rows
    .filter((row) => MANUAL_REPAIRABLE_ACTIONS.has(`${row?.action || ''}`))
    .map((row) => row.assetId)
    .filter(Boolean);
  const normalizeExtractionStatus = (entry = {}, existingRow = {}) => `${entry.extractionStatus || entry.newExtractionStatus || existingRow.extractionStatus || existingRow.newExtractionStatus || ''}`.trim();
  const classifySummaryBucket = (row = {}) => {
    const action = `${row.action || ''}`.trim();
    const status = normalizeExtractionStatus(row, row);
    if (MANUAL_REPAIRABLE_ACTIONS.has(action)) return 'needExtraction';
    if (action === 'already_has_chunks' || status === 'already_has_chunks') return 'alreadyHadText';
    if (status === 'completed' || action === 'materialized' || action === 'reextracted') return 'repaired';
    if (status === 'no_text_extracted') return 'noReadableText';
    if (status === 'unsupported_file_type') return 'unsupportedFile';
    if (status === 'storage_object_missing') return 'missingFile';
    if (status === 'storage_download_failed') return 'downloadFailed';
    if (status === 'pdf_parse_failed') return 'parseFailed';
    if (status === 'skipped') return 'skipped';
    return 'failed';
  };
  const buildManualRepairSummary = (rows = []) => rows.reduce((acc, row) => {
    const bucket = classifySummaryBucket(row);
    acc[bucket] = (acc[bucket] || 0) + 1;
    return acc;
  }, {
    needExtraction: 0,
    repaired: 0,
    alreadyHadText: 0,
    noReadableText: 0,
    unsupportedFile: 0,
    missingFile: 0,
    downloadFailed: 0,
    parseFailed: 0,
    failed: 0,
    skipped: 0,
  });
  const sanitizeRepairErrorMessage = (error) => {
    const code = `${error?.code || ''}`.trim();
    if (code === 'permission-denied') return 'Permission denied while repairing this asset.';
    if (code === 'not-found') return 'Asset not found for repair.';
    return `${error?.message || 'Manual text repair failed.'}`.trim();
  };
  const upsertManualRepairRows = (rows = []) => {
    state.adminUi = {
      ...(state.adminUi || {}),
      manualRepairRows: rows
    };
  };
  const upsertManualRepairSelection = (assetIds = []) => {
    state.adminUi = {
      ...(state.adminUi || {}),
      manualRepairSelectedAssetIds: [...new Set(assetIds.filter(Boolean))]
    };
  };
  const mergeMaterializationResultIntoRow = (row, entry = {}, fallbackError = '') => ({
    ...row,
    action: entry.action || row.action || '',
    reason: entry.reason || row.reason || '',
    extractionStatus: normalizeExtractionStatus(entry, row) || (fallbackError ? 'extraction_failed' : row.extractionStatus || ''),
    extractionReason: `${entry.extractionReason || row.extractionReason || ''}`.trim(),
    extractionError: `${entry.extractionError || ''}`.trim() || fallbackError || `${row.extractionError || ''}`.trim(),
    manualId: entry.manualId || row.manualId || '',
    extractionEngine: entry.extractionEngine || row.extractionEngine || '',
    priorExtractionStatus: entry.priorExtractionStatus || row.priorExtractionStatus || '',
    newExtractionStatus: entry.newExtractionStatus || row.newExtractionStatus || '',
    priorChunkCount: Number.isFinite(Number(entry.priorChunkCount)) ? Number(entry.priorChunkCount) : Number(row.priorChunkCount || 0),
    newChunkCount: Number.isFinite(Number(entry.newChunkCount)) ? Number(entry.newChunkCount) : Number(row.newChunkCount || 0),
    runStatus: fallbackError ? 'failed' : 'completed',
    runMessage: fallbackError || ''
  });
  const mapRepairRowsFromEntries = (entries = [], existingRowsByAsset = new Map()) => entries.map((entry) => {
    const existingRow = existingRowsByAsset.get(entry.assetId) || {};
    return {
      assetId: `${entry.assetId || existingRow.assetId || ''}`.trim(),
      assetName: existingRow.assetName || `${entry.assetName || ''}`.trim() || 'Unknown asset',
      locationName: existingRow.locationName || `${entry.locationName || ''}`.trim() || '—',
      manualStatus: existingRow.manualStatus || `${entry.manualStatus || ''}`.trim() || 'unknown',
      currentExtractionStatus: `${entry.priorExtractionStatus || existingRow.currentExtractionStatus || ''}`.trim() || 'unknown',
      currentChunkCount: Number(entry.priorChunkCount || existingRow.currentChunkCount || 0),
      action: `${entry.action || existingRow.action || ''}`.trim(),
      reason: `${entry.reason || existingRow.reason || ''}`.trim(),
      extractionStatus: normalizeExtractionStatus(entry, existingRow),
      extractionReason: `${entry.extractionReason || existingRow.extractionReason || ''}`.trim(),
      extractionError: `${entry.extractionError || existingRow.extractionError || ''}`.trim(),
      manualId: `${entry.manualId || existingRow.manualId || ''}`.trim(),
      storagePath: `${existingRow.storagePath || entry.storagePath || ''}`.trim(),
      extractionEngine: `${entry.extractionEngine || existingRow.extractionEngine || ''}`.trim(),
      priorExtractionStatus: `${entry.priorExtractionStatus || existingRow.priorExtractionStatus || ''}`.trim(),
      newExtractionStatus: `${entry.newExtractionStatus || existingRow.newExtractionStatus || ''}`.trim(),
      priorChunkCount: Number(entry.priorChunkCount || existingRow.priorChunkCount || 0),
      newChunkCount: Number(entry.newChunkCount || existingRow.newChunkCount || 0),
      runStatus: 'idle',
      runMessage: ''
    };
  }).filter((row) => row.assetId);

  return {
    setImportFeedback,
    setImportConfig: (patch = {}) => {
      state.adminUi = {
        ...(state.adminUi || {}),
        importConfig: {
          ...(state.adminUi?.importConfig || { bootstrapAttachManualsFromCsvHints: false }),
          ...patch
        }
      };
      render();
    },
    setAdminSection: (section) => {
      const normalized = section === 'members' || section === 'workers' || section === 'invites' ? 'people' : section;
      state.adminSection = normalized || 'company';
      render();
    },    setAuditFilter: (category) => {
      state.adminUi = { ...(state.adminUi || {}), auditCategory: category || 'all' };
      render();
    },
    dismissReadinessCard: async () => {
      const readiness = getWorkspaceReadiness(state);
      if (!readiness.requiredComplete) {
        setAdminFeedback({ tone: 'error', message: 'Complete required readiness items before dismissing this panel.' });
        render();
        return;
      }
      state.adminUi = { ...(state.adminUi || {}), readinessAction: 'dismiss' };
      render();
      await runAction('dismiss_workspace_readiness', async () => {
        await saveAppSettings({ ...state.settings, workspaceReadinessDismissedAt: new Date().toISOString() }, state.user);
        await refreshData();
        setAdminFeedback({ tone: 'success', message: 'Workspace readiness panel dismissed. You can show it again anytime.' });
        render();
      }, {
        fallbackMessage: 'Unable to dismiss workspace readiness panel.',
        onFinally: () => {
          state.adminUi = { ...(state.adminUi || {}), readinessAction: '' };
          render();
        }
      });
    },
    showReadinessCard: async () => {
      state.adminUi = { ...(state.adminUi || {}), readinessAction: 'show' };
      render();
      await runAction('show_workspace_readiness', async () => {
        await saveAppSettings({ ...state.settings, workspaceReadinessDismissedAt: null }, state.user);
        await refreshData();
        setAdminFeedback({ tone: 'success', message: 'Workspace readiness panel is visible again.' });
        render();
      }, {
        fallbackMessage: 'Unable to restore workspace readiness panel.',
        onFinally: () => {
          state.adminUi = { ...(state.adminUi || {}), readinessAction: '' };
          render();
        }
      });
    },
    saveWorker: async (id, payload) => {
      const existing = state.workers.find((worker) => worker.id === id) || {};
      const workerEmail = `${payload.email || existing.email || ''}`.trim().toLowerCase();
      await upsertEntity('workers', id, {
        ...existing,
        ...payload,
        email: workerEmail,
        accountStatus: workerEmail ? 'unlinked' : 'directory_only'
      }, state.user);
      await refreshData();
      render();
    },
    saveMemberAccess: async (id, payload) => {
      const existing = state.companyMembers.find((member) => member.id === id);
      if (!existing) {
        setAdminFeedback({ tone: 'error', message: 'Unable to find member record.' });
        render();
        return;
      }
      if ((existing.role || '') === 'owner') {
        setAdminFeedback({ tone: 'error', message: 'Owner role cannot be changed from Admin.' });
        render();
        return;
      }
      await upsertEntity('companyMemberships', id, {
        ...existing,
        role: payload.role || existing.role || 'staff',
        status: payload.status || existing.status || 'active'
      }, state.user);
      setAdminFeedback({ tone: 'success', message: 'Member access updated.' });
      await refreshData();
      render();
    },
    disableMemberAccess: async (id) => {
      const member = getMemberById(id);
      const guard = canManageMembershipAccess(member);
      if (!guard.ok) {
        setAdminFeedback({ tone: 'error', message: guard.reason });
        render();
        return;
      }
      await upsertEntity('companyMemberships', id, { ...member, status: 'inactive' }, state.user);
      const linkedWorker = (state.workers || []).find((worker) => `${worker.userId || worker.linkedUserId || ''}`.trim() === `${member.userId || ''}`.trim());
      if (linkedWorker?.id) {
        await upsertEntity('workers', linkedWorker.id, {
          ...linkedWorker,
          enabled: false,
          available: false,
          accountStatus: 'member_disabled'
        }, state.user);
      }
      setAdminFeedback({ tone: 'success', message: 'Member account disabled.' });
      await refreshData();
      render();
    },
    reactivateMemberAccess: async (id) => {
      const member = getMemberById(id);
      const guard = canManageMembershipAccess(member);
      if (!guard.ok) {
        setAdminFeedback({ tone: 'error', message: guard.reason });
        render();
        return;
      }
      await upsertEntity('companyMemberships', id, { ...member, status: 'active' }, state.user);
      const linkedWorker = (state.workers || []).find((worker) => `${worker.userId || worker.linkedUserId || ''}`.trim() === `${member.userId || ''}`.trim());
      if (linkedWorker?.id) {
        await upsertEntity('workers', linkedWorker.id, {
          ...linkedWorker,
          enabled: true,
          available: true,
          accountStatus: 'linked_member'
        }, state.user);
      }
      setAdminFeedback({ tone: 'success', message: 'Member access reactivated.' });
      await refreshData();
      render();
    },
    removeMemberAccess: async (id) => {
      const member = getMemberById(id);
      const guard = canManageMembershipAccess(member);
      if (!guard.ok) {
        setAdminFeedback({ tone: 'error', message: guard.reason });
        render();
        return;
      }
      if (typeof deleteEntity !== 'function') {
        setAdminFeedback({ tone: 'error', message: 'Remove access is unavailable in this environment.' });
        render();
        return;
      }
      await deleteEntity('companyMemberships', id, state.user);
      const linkedWorker = (state.workers || []).find((worker) => `${worker.userId || worker.linkedUserId || ''}`.trim() === `${member.userId || ''}`.trim());
      if (linkedWorker?.id) {
        await upsertEntity('workers', linkedWorker.id, {
          ...linkedWorker,
          enabled: false,
          available: false,
          accountStatus: 'access_removed'
        }, state.user);
      }
      setAdminFeedback({ tone: 'success', message: 'App access removed. Worker profile was deactivated.' });
      await refreshData();
      render();
    },
    createWorker: async (payload) => {
      const id = `worker-${Date.now().toString(36)}`;
      const workerEmail = `${payload.email || ''}`.trim().toLowerCase();
      await upsertEntity('workers', id, {
        id,
        displayName: `${payload.displayName || ''}`.trim(),
        email: workerEmail,
        role: payload.role || 'staff',
        enabled: true,
        available: true,
        skills: `${payload.skills || ''}`.split(/[|,;]+/).map((value) => value.trim()).filter(Boolean),
        inviteStatus: payload.sendInvite === 'yes' && workerEmail ? 'pending' : 'not_invited',
        accountStatus: workerEmail ? 'unlinked' : 'directory_only',
        phone: '',
        defaultLocationId: `${payload.defaultLocationId || ''}`.trim(),
        locationName: `${payload.locationName || ''}`.trim()
      }, state.user);
      let inviteMessage = '';
      if (payload.sendInvite === 'yes' && workerEmail) {
        const invite = await createCompanyInvite({ companyId: state.company.id, email: workerEmail, role: payload.role || 'staff', user: state.user });
        inviteMessage = ` Invite code ${invite.inviteCode} created.`;
      }
      setAdminFeedback({ tone: 'success', message: `Worker record created for ${`${payload.displayName || 'new worker'}`.trim() || id}.${inviteMessage}` });
      await refreshData();
      render();
    },
    createInvite: async ({ name, email, role, createWorkerProfile, workerTitle, workerNotes }) => {
      await runAction('create_invite', async () => {
        const cleanEmail = `${email || ''}`.trim().toLowerCase();
        const cleanRole = `${role || 'staff'}`.trim() || 'staff';
        const shouldCreateWorkerProfile = createWorkerProfile === true || `${createWorkerProfile || ''}`.trim() === 'on';
        try {
          const invite = await createCompanyInvite({
            companyId: state.company.id,
            email: cleanEmail,
            role: cleanRole,
            user: state.user,
            displayName: `${name || ''}`.trim(),
            createWorkerProfile: shouldCreateWorkerProfile,
            workerTitle: `${workerTitle || ''}`.trim(),
            workerNotes: `${workerNotes || ''}`.trim()
          });
          const returnedInvite = invite?.invite && typeof invite.invite === 'object'
            ? invite.invite
            : {};
          const mergedInvite = {
            id: invite.id || returnedInvite.id,
            companyId: returnedInvite.companyId || state.company.id,
            email: returnedInvite.email || cleanEmail,
            role: returnedInvite.role || cleanRole,
            displayName: returnedInvite.displayName || `${name || ''}`.trim(),
            inviteCode: invite.inviteCode || returnedInvite.inviteCode || '',
            inviteCodeNormalized: returnedInvite.inviteCodeNormalized || '',
            token: invite.token || returnedInvite.token || '',
            status: returnedInvite.status || 'pending',
            createWorkerProfile: returnedInvite.createWorkerProfile ?? shouldCreateWorkerProfile,
            workerTitle: returnedInvite.workerTitle || `${workerTitle || ''}`.trim(),
            workerNotes: returnedInvite.workerNotes || `${workerNotes || ''}`.trim(),
            createdBy: returnedInvite.createdBy || `${state.user?.uid || ''}`.trim(),
            updatedBy: returnedInvite.updatedBy || `${state.user?.uid || ''}`.trim(),
            expiresAt: returnedInvite.expiresAt || null
          };
          state.invites = [mergedInvite, ...(state.invites || []).filter((entry) => entry.id !== mergedInvite.id)];
          setAdminFeedback({ tone: 'success', message: `Invite created for ${cleanEmail}. Share code ${mergedInvite.inviteCode}.` });
          render();
          await refreshData();
          render();
        } catch (error) {
          const errorCode = `${error?.code || ''}`.trim().toLowerCase();
          const permissionDenied = errorCode.includes('permission-denied')
            || `${error?.message || ''}`.toLowerCase().includes('permission-denied');
          const activeMember = (state.companyMembers || []).find((member) => `${member?.userId || ''}`.trim() === `${state.user?.uid || ''}`.trim());
          const diagnostics = {
            uid: `${state.user?.uid || ''}`.trim() || 'unknown',
            companyId: `${state.company?.id || ''}`.trim() || 'unknown',
            membershipRole: `${activeMember?.role || state.permissions?.companyRole || 'unknown'}`.trim() || 'unknown',
            membershipStatus: `${activeMember?.status || 'unknown'}`.trim() || 'unknown'
          };
          console.warn('[people_invites] create invite failed', diagnostics, error);
          const diagnosticsText = `uid=${diagnostics.uid}, companyId=${diagnostics.companyId}, role=${diagnostics.membershipRole}, status=${diagnostics.membershipStatus}`;
          const message = permissionDenied
            ? 'Invite could not be created. Your current membership is missing, inactive, or does not have People management access.'
            : `${error?.message || 'Unable to create invite.'}`;
          setAdminFeedback({ tone: 'error', message: `${message} (${diagnosticsText})` });
          render();
          throw error;
        }
      }, { fallbackMessage: 'Unable to create invite.' });
    },
    sendPersonPasswordReset: async (email) => {
      const cleanEmail = `${email || ''}`.trim().toLowerCase();
      if (!cleanEmail) {
        setAdminFeedback({ tone: 'error', message: 'No email found for this person.' });
        render();
        return;
      }
      state.adminUi = { ...(state.adminUi || {}), passwordResetByEmail: { ...(state.adminUi?.passwordResetByEmail || {}), [cleanEmail]: 'loading' } };
      render();
      try {
        await sendForgotPasswordEmail(cleanEmail);
        state.adminUi = { ...(state.adminUi || {}), passwordResetByEmail: { ...(state.adminUi?.passwordResetByEmail || {}), [cleanEmail]: 'success' } };
        setAdminFeedback({ tone: 'success', message: `Password reset email sent to ${cleanEmail}.` });
      } catch (error) {
        state.adminUi = { ...(state.adminUi || {}), passwordResetByEmail: { ...(state.adminUi?.passwordResetByEmail || {}), [cleanEmail]: 'error' } };
        setAdminFeedback({ tone: 'error', message: `${error?.message || 'Unable to send password reset email.'}` });
      }
      render();
    },
    toggleWorkerProfile: async ({ email, userId, displayName, enabled }) => {
      const cleanEmail = `${email || ''}`.trim().toLowerCase();
      const cleanUserId = `${userId || ''}`.trim();
      if (enabled) {
        const existing = (state.workers || []).find((worker) => (
          (cleanUserId && `${worker.userId || worker.linkedUserId || ''}`.trim() === cleanUserId)
          || (cleanEmail && `${worker.email || ''}`.trim().toLowerCase() === cleanEmail)
        ));
        if (existing?.id) {
          await upsertEntity('workers', existing.id, {
            ...existing,
            enabled: false,
            available: false,
            updatedAt: new Date().toISOString(),
          }, state.user);
        }
        setAdminFeedback({ tone: 'success', message: `Worker profile removed for ${cleanEmail || displayName || 'person'}.` });
      } else {
        const id = `worker-${(cleanUserId || cleanEmail || Date.now().toString(36)).replace(/[^a-z0-9-]/gi, '-').slice(0, 64)}`;
        await upsertEntity('workers', id, {
          id,
          displayName: `${displayName || cleanEmail || cleanUserId || 'Worker'}`.trim(),
          email: cleanEmail,
          userId: cleanUserId,
          linkedUserId: cleanUserId,
          enabled: true,
          available: true,
          role: 'staff',
          accountStatus: cleanUserId ? 'linked_member' : 'pending_link',
          notes: '',
          title: '',
          companyId: state.company?.id || ''
        }, state.user);
        setAdminFeedback({ tone: 'success', message: `Worker profile enabled for ${cleanEmail || displayName || 'person'}.` });
      }
      await refreshData();
      render();
    },
    saveWorkerProfile: async (workerId, payload = {}) => {
      const existing = (state.workers || []).find((worker) => worker.id === workerId);
      if (!existing) return;
      await upsertEntity('workers', workerId, {
        ...existing,
        title: `${payload.title || ''}`.trim(),
        notes: `${payload.notes || ''}`.trim(),
      }, state.user);
      setAdminFeedback({ tone: 'success', message: 'Worker profile updated.' });
      await refreshData();
      render();
    },

    setWorkerPin: async ({ workerId, locationId, pin } = {}) => {
      const companyId = `${state.company?.id || ''}`.trim();
      const cleanWorkerId = `${workerId || ''}`.trim();
      const cleanLocationId = `${locationId || ''}`.trim();
      const cleanPin = `${pin || ''}`.trim();
      if (!companyId || !cleanWorkerId || !cleanLocationId) {
        setAdminFeedback({ tone: 'error', message: 'Select a worker and location before setting a PIN.' });
        render();
        return { ok: false };
      }
      if (!/^\d{4,8}$/.test(cleanPin)) {
        setAdminFeedback({ tone: 'error', message: 'PIN must be 4–8 digits.' });
        render();
        return { ok: false };
      }
      try {
        await setWorkerLocationPin({ companyId, workerId: cleanWorkerId, locationId: cleanLocationId, pin: cleanPin });
        setAdminFeedback({ tone: 'success', message: 'PIN set successfully.' });
        render();
        return { ok: true };
      } catch {
        setAdminFeedback({ tone: 'error', message: 'Unable to set PIN. Check your permissions and try again.' });
        render();
        return { ok: false };
      }
    },
    saveChecklistTemplate: async (payload = {}) => {
      const companyId = `${state.company?.id || ''}`.trim();
      const templateType = `${payload.templateType || ''}`.trim();
      const locationId = `${payload.locationId || ''}`.trim();
      const name = `${payload.name || ''}`.trim();
      const checklistItems = Array.isArray(payload.checklistItems) ? payload.checklistItems : [];
      if (!companyId || !templateType || !locationId || !name) {
        setAdminFeedback({ tone: 'error', message: 'Select location, template type, and template name.' });
        render();
        return;
      }
      const existing = (state.checklistTemplates || []).find((entry) => entry.companyId === companyId && entry.locationId === locationId && entry.templateType === templateType);
      const id = existing?.id || `template-${templateType}-${locationId}`.replace(/[^a-z0-9_-]/gi, '-');
      await upsertEntity('checklistTemplates', id, {
        ...(existing || {}),
        id,
        companyId,
        locationId,
        templateType,
        name,
        active: payload.active !== false,
        checklistItems
      }, state.user);
      setAdminFeedback({ tone: 'success', message: 'Checklist template saved.' });
      await refreshData();
      render();
    },
    revokeInvite: async (inviteId) => {
      await revokeInvite(inviteId, state.user);
      setAdminFeedback({ tone: 'success', message: 'Invite revoked.' });
      await refreshData();
      render();
    },
    addLocation: async (payload) => {
      const id = `loc-${Date.now().toString(36)}`;
      await runAction('add_location', async () => {
        await upsertEntity('companyLocations', id, withRequiredCompanyId({ id, ...payload }, 'add a company location'), state.user);
        setAdminFeedback({ tone: 'success', message: `Location added: ${payload.name || id}.` });
        await refreshData();
        render();
      }, { fallbackMessage: 'Unable to add company location.' });
    },
    updateCompanyBilling: async (payload) => {
      if (!state.company?.id) {
        setAdminFeedback({ tone: 'error', message: 'No active company found.' });
        render();
        return;
      }
      await runAction('update_company_billing', async () => {
        const seatLimitRaw = Number(payload.seatLimit);
        const seatLimit = Number.isFinite(seatLimitRaw) && seatLimitRaw > 0 ? Math.round(seatLimitRaw) : null;
        const usageSummary = buildUsageSummary({
          members: state.companyMembers || [],
          workers: state.workers || [],
          locations: state.companyLocations || [],
          assets: state.assets || [],
          seatLimit
        });
        await upsertEntity('companies', state.company.id, withRequiredCompanyId({
          ...state.company,
          trialStatus: `${payload.trialStatus || state.company?.trialStatus || 'active'}`.trim(),
          trialEndsAt: `${payload.trialEndsAt || state.company?.trialEndsAt || ''}`.trim(),
          trialLengthDays: Number(payload.trialLengthDays) > 0 ? Number(payload.trialLengthDays) : (state.company?.trialLengthDays || null),
          subscriptionStatus: `${payload.subscriptionStatus || state.company?.subscriptionStatus || 'trialing'}`.trim(),
          planKey: `${payload.planKey || state.company?.planKey || 'starter_trial'}`.trim(),
          billingEmail: `${payload.billingEmail || ''}`.trim().toLowerCase(),
          billingContactName: `${payload.billingContactName || ''}`.trim(),
          seatLimit,
          billingAddress: normalizeBillingAddress({
            line1: payload.billingAddressLine1,
            line2: payload.billingAddressLine2,
            city: payload.billingAddressCity,
            state: payload.billingAddressState,
            postalCode: payload.billingAddressPostalCode,
            country: payload.billingAddressCountry
          }),
          usageSummary
        }, 'update company billing'), state.user);
        setAdminFeedback({ tone: 'success', message: 'Billing and plan settings saved.' });
        await refreshData();
        render();
      }, { fallbackMessage: 'Unable to update billing settings.' });
    },
    updateCompanyProfile: async (payload) => {
      if (!state.company?.id) {
        setAdminFeedback({ tone: 'error', message: 'No active company found.' });
        render();
        return;
      }
      state.adminUi = { ...(state.adminUi || {}), companySettingsBusy: true };
      render();
      await safeWithGlobalBusy('Saving company settings…', 'Uploading logo and updating workspace branding.', async () => runAction('update_company_profile', async () => {
        let logoStoragePath = `${state.company?.logoStoragePath || ''}`.trim();
        let logoUrl = `${payload.logoUrl || ''}`.trim();
        const file = payload.logoFile;
        if (file && state.company?.id) {
          if (!storage || typeof storageRef !== 'function' || typeof uploadBytes !== 'function' || typeof getDownloadURL !== 'function' || typeof buildCompanyBrandingLogoPath !== 'function') {
            throw new Error('Logo upload is unavailable because storage runtime is missing.');
          }
          const extension = `${file.name || ''}`.trim().split('.').pop();
          const safeName = `${Date.now()}-${buildSafeLogoFileName(file.name || 'logo')}`;
          const finalName = extension && !safeName.endsWith(`.${extension}`) ? `${safeName}.${extension.toLowerCase()}` : safeName;
          logoStoragePath = buildCompanyBrandingLogoPath(state.company.id, finalName);
          const logoRef = storageRef(storage, logoStoragePath);
          await uploadBytes(logoRef, file, { contentType: file.type || 'application/octet-stream' });
          logoUrl = await getDownloadURL(logoRef).catch(() => logoUrl);
        }
        const updatedCompany = withRequiredCompanyId({
          ...state.company,
          name: `${payload.name || state.company?.name || ''}`.trim(),
          primaryEmail: `${payload.primaryEmail || state.company?.primaryEmail || ''}`.trim(),
          primaryPhone: `${payload.primaryPhone || state.company?.primaryPhone || ''}`.trim(),
          timeZone: `${payload.timeZone || state.company?.timeZone || 'UTC'}`.trim(),
          businessType: `${payload.businessType || ''}`.trim(),
          industry: `${payload.industry || ''}`.trim(),
          logoUrl,
          logoStoragePath,
          hqStreet: `${payload.hqStreet || ''}`.trim(),
          hqCity: `${payload.hqCity || ''}`.trim(),
          hqState: `${payload.hqState || ''}`.trim(),
          hqZip: `${payload.hqZip || ''}`.trim()
        }, 'update company profile');
        await upsertEntity('companies', state.company.id, updatedCompany, state.user);
        state.company = { ...(state.company || {}), ...updatedCompany };
        setAdminFeedback({ tone: 'success', message: 'Company profile settings saved.' });
        await refreshData();
        render();
      }, {
        fallbackMessage: 'Unable to update company profile.',
        onFinally: () => {
          state.adminUi = { ...(state.adminUi || {}), companySettingsBusy: false };
          render();
        }
      }));
    },
    copyInviteCode: async (inviteCode) => {
      const code = `${inviteCode || ''}`.trim();
      if (!code) return;
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) await navigator.clipboard.writeText(code);
        setAdminFeedback({ tone: 'success', message: `Invite code ${code} copied to clipboard.` });
      } catch {
        setAdminFeedback({ tone: 'error', message: `Unable to copy invite code automatically. Copy manually: ${code}` });
      }
      render();
    },
    updateLocation: async (id, payload) => {
      const existing = (state.companyLocations || []).find((location) => location.id === id);
      if (!existing) {
        setAdminFeedback({ tone: 'error', message: 'Location record not found.' });
        render();
        return;
      }
      await runAction('update_location', async () => {
        await upsertEntity('companyLocations', id, withRequiredCompanyId({
          ...existing,
          name: `${payload.name || existing.name || ''}`.trim(),
          address: `${payload.address || ''}`.trim(),
          timeZone: `${payload.timeZone || existing.timeZone || state.company?.timeZone || 'UTC'}`.trim(),
          managerName: `${payload.managerName || ''}`.trim(),
          status: `${payload.status || 'active'}`.trim(),
          notes: `${payload.notes || ''}`.trim()
        }, 'update company location'), state.user);
        setAdminFeedback({ tone: 'success', message: `Location updated: ${payload.name || existing.name || id}.` });
        await refreshData();
        render();
      }, { fallbackMessage: 'Unable to update location settings.' });
    },
    downloadAssetTemplate: () => downloadFile('asset-template.csv', ASSET_CSV_TEMPLATE, 'text/csv'),
    downloadEmployeeTemplate: () => downloadFile('employee-template.csv', 'name,email,role,enabled,available,shift start,skills,location,phone\n', 'text/csv'),
    importAssets: async (rows, options = {}) => safeWithGlobalBusy('Importing accepted assets…', 'This can take a few seconds. Please do not refresh.', async () => {
      if (!rows.length) {
        setImportFeedback({ tone: 'error', summary: 'No asset rows were imported.', preview: state.adminUi?.importPreview || '' });
        return;
      }
      let imported = 0;
      let skipped = 0;
      let enrichmentStarted = 0;
      let enrichmentQueued = 0;
      let enrichmentCompleted = 0;
      let enrichmentFailed = 0;
      let bootstrapAttached = 0;
      let bootstrapFailed = 0;
      let bootstrapNoDirectManualUrl = 0;
      let completedRows = 0;
      const bootstrapMode = options.bootstrapAttachManualsFromCsvHints === true;
      state.adminUi = {
        ...(state.adminUi || {}),
        importConfig: {
          ...(state.adminUi?.importConfig || { bootstrapAttachManualsFromCsvHints: false }),
          bootstrapAttachManualsFromCsvHints: bootstrapMode
        }
      };
      const importedRowLinks = [];
      const emitProgress = () => {
        const summary = bootstrapMode
          ? `Importing in direct CSV bootstrap mode: ${completedRows}/${rows.length} rows completed. Imported assets ${imported}. Attached ${bootstrapAttached}. Attach failed ${bootstrapFailed}. No direct manual URL ${bootstrapNoDirectManualUrl}.`
          : `Assets import running: ${completedRows}/${rows.length} rows completed. Imported assets ${imported}. Queued for research ${enrichmentQueued}.`;
        setImportFeedback({
          tone: 'info',
          summary,
          preview: state.adminUi?.importPreview || '',
          progress: {
            totalRows: rows.length,
            importedAssets: imported,
            directManualsAttached: bootstrapAttached,
            directManualAttachFailed: bootstrapFailed,
            noDirectManualUrl: bootstrapNoDirectManualUrl,
            completedRows,
            bootstrapMode,
            isRunning: completedRows < rows.length,
          }
        });
      };
      emitProgress();
      for (const row of rows) {
        const mapped = buildAssetImportRow({
          name: row['asset name'] || row.name || '',
          assetId: row.assetId || row.id || '',
          manufacturer: row.manufacturer || '',
          model: row.model || '',
          serialNumber: row.serial || row.serialNumber || '',
          locationName: row.location || row.locationName || '',
          zone: row.zone || row.area || '',
          notes: row.notes || '',
          category: row.category || row.type || '',
          status: row.status || 'active',
          alternateNames: `${row.alternateNames || ''}`.split(/[|,;]+/).map((value) => value.trim()).filter(Boolean),
          subtitleOrVersion: row.subtitleOrVersion || '',
          playerCount: row.playerCount || '',
          cabinetType: row.cabinetType || '',
          vendorOrDistributor: row.vendorOrDistributor || '',
          manualHintUrl: row.manualHintUrl || row.manualUrl || '',
          manualSourceHintUrl: row.manualSourceHintUrl || row.manualSourceUrl || '',
          supportHintUrl: row.supportHintUrl || row.supportUrl || '',
          manufacturerWebsite: row.manufacturerWebsite || '',
          externalAssetKey: row.externalAssetKey || '',
          supportEmail: row.supportEmail || '',
          supportPhone: row.supportPhone || '',
          matchConfidence: row.matchConfidence || row.enrichmentConfidence || '',
          matchNotes: row.matchNotes || ''
        });
        const id = `${mapped.assetId || normalizeAssetId(mapped['asset name'] || '')}`.trim();
        if (!id) {
          skipped += 1;
          completedRows += 1;
          emitProgress();
          continue;
        }
        const manualHintUrl = `${mapped.manualHintUrl || ''}`.trim();
        const manualSourceHintUrl = `${mapped.manualSourceHintUrl || ''}`.trim();
        const supportHintUrl = `${mapped.supportHintUrl || ''}`.trim();
        const documentationSuggestions = manualHintUrl
          ? [{
            title: 'CSV intake manual hint',
            url: manualHintUrl,
            sourcePageUrl: manualSourceHintUrl || supportHintUrl,
            sourceType: 'intake_hint',
            verified: false,
            trustedSource: false,
            exactManualMatch: false,
            exactTitleMatch: false
          }]
          : [];
        const supportContacts = [];
        if (row.supportEmail) supportContacts.push({ contactType: 'email', label: 'Support email', value: `${row.supportEmail || ''}`.trim() });
        if (row.supportPhone) supportContacts.push({ contactType: 'phone', label: 'Support phone', value: `${row.supportPhone || ''}`.trim() });
        await upsertEntity('assets', id, withRequiredCompanyId({
          id,
          name: mapped['asset name'] || id,
          manufacturer: mapped.manufacturer || '',
          model: mapped.model || '',
          serialNumber: mapped.serial || '',
          locationName: mapped.location || '',
          zone: mapped.zone || '',
          notes: mapped.notes || mapped.matchNotes || '',
          category: mapped.category || '',
          status: mapped.status || 'active',
          alternateNames: `${mapped.alternateNames || ''}`.split(/[|,;]+/).map((value) => value.trim()).filter(Boolean),
          subtitleOrVersion: mapped.subtitleOrVersion || '',
          playerCount: mapped.playerCount || '',
          cabinetType: mapped.cabinetType || '',
          vendorOrDistributor: mapped.vendorOrDistributor || '',
          manufacturerWebsite: mapped.manufacturerWebsite || '',
          externalAssetKey: mapped.externalAssetKey || '',
          manualHintUrl,
          manualSourceHintUrl,
          supportHintUrl,
          documentationSuggestions,
          supportResourcesSuggestion: supportHintUrl ? [{ url: supportHintUrl, label: 'CSV intake support hint', sourceType: 'intake_hint', trustedSource: false }] : [],
          supportContactsSuggestion: supportContacts,
          enrichmentConfidence: Number(mapped.matchConfidence || 0) || null,
          matchNotes: mapped.matchNotes || '',
          importSource: 'assets_csv_v2',
          enrichmentStatus: bootstrapMode ? 'imported_no_direct_manual' : 'queued',
          enrichmentRequestedAt: new Date().toISOString()
        }, 'import assets'), state.user);
        let intakeStatusBadge = 'queued';
        let intakeStatusLabel = 'queued';
        imported += 1;

        let bootstrapAttachedForAsset = false;
        if (bootstrapMode && manualHintUrl && typeof bootstrapAttachAssetManualFromCsvHint === 'function') {
          try {
            const bootstrapResult = await bootstrapAttachAssetManualFromCsvHint({
              assetId: id,
              manualHintUrl,
              manualSourceHintUrl,
              supportHintUrl,
            });
            bootstrapAttachedForAsset = bootstrapResult?.attached === true;
            if (bootstrapAttachedForAsset) {
              bootstrapAttached += 1;
              intakeStatusBadge = 'docs_found';
              intakeStatusLabel = 'docs found / attached';
            } else {
              bootstrapFailed += 1;
              await upsertEntity('assets', id, withRequiredCompanyId({
                id,
                enrichmentStatus: 'imported_manual_attach_failed',
                enrichmentTerminalReason: `${bootstrapResult?.status || 'bootstrap_attach_failed'}`.slice(0, 120),
                manualReady: false,
              }, 'mark bootstrap attach failure'), state.user);
            }
          } catch (error) {
            bootstrapFailed += 1;
            await upsertEntity('assets', id, withRequiredCompanyId({
              id,
              enrichmentStatus: 'imported_manual_attach_failed',
              enrichmentTerminalReason: 'bootstrap_attach_exception',
              manualReady: false,
            }, 'mark bootstrap attach failure'), state.user);
            console.error('[import_asset_bootstrap_attach]', { assetId: id, error });
          }
        }

        if (!bootstrapAttachedForAsset) {
          if (bootstrapMode) {
            if (!manualHintUrl) bootstrapNoDirectManualUrl += 1;
          } else {
            enrichmentQueued += 1;
            if (typeof enrichAssetDocumentation === 'function') {
              try {
                enrichmentStarted += 1;
                await enrichAssetDocumentation(id, { trigger: 'csv_import' });
                enrichmentCompleted += 1;
              } catch (error) {
                enrichmentFailed += 1;
                console.error('[import_asset_enrichment]', { assetId: id, error });
              }
            }
          }
        }

        importedRowLinks.push({
          name: mapped['asset name'] || id,
          manufacturer: mapped.manufacturer || '',
          assetId: id,
          intakeStatusBadge,
          intakeStatusLabel,
        });
        completedRows += 1;
        emitProgress();
      }
      await upsertEntity('importHistory', `import-assets-${Date.now()}`, { type: 'assets', rowCount: rows.length }, state.user);
      const bootstrapSummary = bootstrapMode
        ? ` Bootstrap attached ${bootstrapAttached}, failed ${bootstrapFailed}, no direct manual URL ${bootstrapNoDirectManualUrl}.`
        : '';
      const enrichmentSummary = typeof enrichAssetDocumentation === 'function'
        ? (bootstrapMode
          ? ' Direct bootstrap mode skipped enrichment/research queueing.'
          : ` Queued for research ${enrichmentQueued}. Enrichment started ${enrichmentStarted}, completed ${enrichmentCompleted}, failed ${enrichmentFailed}.`)
        : (bootstrapMode
          ? ' Direct bootstrap mode skipped enrichment/research queueing.'
          : ` Queued for research ${enrichmentQueued}; no inline runner is configured in this session.`);
      setImportFeedback({
        tone: imported ? (enrichmentFailed ? 'info' : 'success') : 'error',
        summary: `Assets import complete. Imported ${imported}${skipped ? `, skipped ${skipped}` : ''}.${bootstrapSummary}${enrichmentSummary}`,
        preview: state.adminUi?.importPreview || '',
        progress: {
          totalRows: rows.length,
          importedAssets: imported,
          directManualsAttached: bootstrapAttached,
          directManualAttachFailed: bootstrapFailed,
          noDirectManualUrl: bootstrapNoDirectManualUrl,
          completedRows,
          bootstrapMode,
          isRunning: false,
        }
      });
      setAdminFeedback({
        tone: imported ? (enrichmentFailed ? 'info' : 'success') : 'error',
        message: imported
          ? `Imported ${imported} asset rows.${bootstrapSummary}${enrichmentSummary}`
          : 'No asset rows were imported.'
      });
      await refreshData();
      const assetById = new Map((state.assets || []).map((asset) => [asset.id, asset]));
      const reconciledRows = importedRowLinks.map((row) => {
        const linked = assetById.get(row.assetId);
        if (!linked) return row;
        return { ...row, ...mapRowStatusFromAsset(linked) };
      });
      state.assetUi = {
        ...(state.assetUi || {}),
        recentIntakeRows: [
          ...(Array.isArray(state.assetUi?.recentIntakeRows) ? state.assetUi.recentIntakeRows : []),
          ...reconciledRows
        ]
      };
      render();
    }),
    importEmployees: async (rows) => {
      if (!rows.length) {
        setImportFeedback({ tone: 'error', summary: 'No worker rows were imported.', preview: state.adminUi?.importPreview || '' });
        return;
      }
      let imported = 0;
      for (const row of rows) {
        const id = `worker-${(row.email || row.name || Date.now()).toString().toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
        await upsertEntity('workers', id, {
          id,
          displayName: row.name || '',
          email: (row.email || '').toLowerCase(),
          role: row.role || 'staff',
          enabled: `${row.enabled || 'true'}`.toLowerCase() !== 'false',
          available: `${row.available || 'true'}`.toLowerCase() !== 'false',
          shiftStart: row['shift start'] || row.shiftStart || '',
          skills: `${row.skills || ''}`.split(/[|;]+/).map((value) => value.trim()).filter(Boolean),
          locationName: row.location || '',
          phone: row.phone || '',
          accountStatus: row.email ? 'unlinked' : 'directory_only'
        }, state.user);
        imported += 1;
      }
      await upsertEntity('importHistory', `import-employees-${Date.now()}`, { type: 'employees', rowCount: rows.length }, state.user);
      setImportFeedback({ tone: imported ? 'success' : 'error', summary: `Workers import complete. Imported ${imported} rows.`, preview: state.adminUi?.importPreview || '' });
      setAdminFeedback({ tone: imported ? 'success' : 'error', message: imported ? `Imported ${imported} worker rows.` : 'No worker rows were imported.' });
      await refreshData();
      render();
    },
    exportAssetsCsv: async () => downloadFile(`assets-export-${Date.now()}.csv`, buildAssetsCsv(state.assets || []), 'text/csv'),
    exportTasksCsv: async () => downloadFile(`tasks-export-${Date.now()}.csv`, buildTasksCsv(state.tasks || []), 'text/csv'),
    exportAuditCsv: async () => downloadFile(`audit-log-export-${Date.now()}.csv`, buildAuditCsv(state.auditEntries || []), 'text/csv'),
    exportWorkersCsv: async () => downloadFile(`workers-export-${Date.now()}.csv`, buildWorkersCsv(state.workers || []), 'text/csv'),
    exportMembersCsv: async () => downloadFile(`members-export-${Date.now()}.csv`, buildMembersCsv(state.companyMembers || []), 'text/csv'),
    exportInvitesCsv: async () => downloadFile(`invites-export-${Date.now()}.csv`, buildInvitesCsv(state.invites || []), 'text/csv'),
    exportLocationsCsv: async () => downloadFile(`locations-export-${Date.now()}.csv`, buildLocationsCsv(state.companyLocations || []), 'text/csv'),
    exportCompanyBundle: async () => downloadJson(`company-backup-${Date.now()}.json`, buildCompanyBackupBundle({
      company: state.company || {},
      assets: state.assets || [],
      tasks: state.tasks || [],
      auditEntries: state.auditEntries || [],
      companyMembers: state.companyMembers || [],
      workers: state.workers || [],
      invites: state.invites || [],
      locations: state.companyLocations || []
    })),
    exportBackup: async () => downloadJson(`scoot-business-backup-${Date.now()}.json`, await exportBackupJson()),
    clearTasks: async () => {
      const tasksCleared = await clearEntitySet('tasks', state.user);
      const operationsCleared = await clearEntitySet('operations', state.user);
      setAdminFeedback({ tone: 'success', message: `Cleared ${tasksCleared} tasks and ${operationsCleared} operations.` });
      await refreshData();
      render();
    },
    clearAssets: async () => {
      const count = await clearEntitySet('assets', state.user);
      setAdminFeedback({ tone: 'success', message: `Cleared ${count} assets.` });
      await refreshData();
      render();
    },
    clearWorkers: async () => {
      const count = await clearEntitySet('workers', state.user, (worker) => (worker.email || '').toLowerCase() !== (state.user.email || '').toLowerCase());
      setAdminFeedback({ tone: 'success', message: `Cleared ${count} worker directory entries.` });
      await refreshData();
      render();
    },
    resetWorkspace: async () => {
      await clearEntitySet('tasks', state.user);
      await clearEntitySet('operations', state.user);
      await clearEntitySet('assets', state.user);
      await clearEntitySet('notes', state.user);
      await clearEntitySet('manuals', state.user);
      await clearEntitySet('taskAiRuns', state.user);
      await clearEntitySet('taskAiFollowups', state.user);
      await clearEntitySet('troubleshootingLibrary', state.user);
      setAdminFeedback({ tone: 'success', message: 'Workspace reset complete. Company profile, owner membership, and locations were kept.' });
      await refreshData();
      render();
    },
    saveAISettings: async (settings) => {
      await saveAppSettings({ ...settings, aiConfiguredExplicitly: true }, state.user);
      setAdminFeedback({ tone: 'success', message: 'AI settings saved.' });
      await refreshData();
      render();
    },
    saveNotificationPrefs: async (enabledTypes = []) => {
      await saveAppSettings({
        ...state.settings,
        notificationPrefs: { enabledTypes }
      }, state.user);
      setAdminFeedback({ tone: 'success', message: 'Notification preferences saved.' });
      await refreshData();
      render();
    },
    checkManualTextExtraction: async ({ limit = 100 } = {}) => safeWithGlobalBusy('Checking manual text…', 'This can take a few seconds. Please do not refresh.', async () => {
      if (!canRunManualRepair()) return;
      const companyId = `${state.company?.id || ''}`.trim();
      if (!companyId) {
        state.adminUi = { ...(state.adminUi || {}), manualRepairError: 'No active company found.' };
        render();
        return;
      }
      state.adminUi = {
        ...(state.adminUi || {}),
        manualRepairScanStatus: 'running',
        manualRepairMessage: 'Checking attached manuals…',
        manualRepairError: '',
        manualRepairProgress: null,
        manualRepairRows: [],
        manualRepairSelectedAssetIds: []
      };
      render();
      try {
        const result = await repairAssetDocumentationState({ companyId, dryRun: true, limit: Math.max(1, Math.min(Number(limit) || 100, 100)) });
        const assetsById = new Map((state.assets || []).map((asset) => [asset.id, asset]));
        const rows = mapRepairRowsFromEntries(result?.manualMaterialization?.entries || []).map((row) => {
          const asset = assetsById.get(row.assetId) || {};
          return {
            ...row,
            assetName: row.assetName === 'Unknown asset' ? (asset.name || 'Unknown asset') : row.assetName,
            locationName: row.locationName === '—' ? (asset.locationName || asset.zone || '—') : row.locationName,
            manualStatus: row.manualStatus === 'unknown' ? `${asset.manualStatus || 'unknown'}`.trim() : row.manualStatus,
            storagePath: row.storagePath || `${asset.manualStoragePath || ''}`.trim(),
            latestManualId: row.manualId || `${asset.latestManualId || ''}`.trim()
          };
        });
        const defaultSelected = getRepairableAssetIds(rows);
        state.adminUi = {
          ...(state.adminUi || {}),
          manualRepairScanStatus: 'completed',
          manualRepairMessage: `Checked ${rows.length} asset${rows.length === 1 ? '' : 's'} for manual text extraction.`,
          manualRepairError: '',
          manualRepairProgress: null,
          manualRepairRows: rows,
          manualRepairSelectedAssetIds: defaultSelected,
          manualRepairSummary: buildManualRepairSummary(rows)
        };
      } catch (error) {
        state.adminUi = {
          ...(state.adminUi || {}),
          manualRepairScanStatus: 'error',
          manualRepairMessage: '',
          manualRepairError: sanitizeRepairErrorMessage(error),
          manualRepairProgress: null,
          manualRepairRows: [],
          manualRepairSelectedAssetIds: []
        };
      }
      render();
    }),
    selectAllManualRepairRows: () => {
      const rows = state.adminUi?.manualRepairRows || [];
      upsertManualRepairSelection(getRepairableAssetIds(rows));
      render();
    },
    clearManualRepairSelection: () => {
      upsertManualRepairSelection([]);
      render();
    },
    toggleManualRepairSelection: (assetId, selected) => {
      const existing = new Set(state.adminUi?.manualRepairSelectedAssetIds || []);
      if (selected) existing.add(assetId);
      else existing.delete(assetId);
      upsertManualRepairSelection([...existing]);
      render();
    },
    runManualRepairForSelection: async ({ assetIds = null, concurrency = 3 } = {}) => safeWithGlobalBusy('Extracting manual text…', 'This can take a few seconds. Please do not refresh.', async () => {
      if (!canRunManualRepair()) return;
      const selectedIds = (Array.isArray(assetIds) ? assetIds : (state.adminUi?.manualRepairSelectedAssetIds || [])).filter(Boolean);
      if (!selectedIds.length) {
        state.adminUi = { ...(state.adminUi || {}), manualRepairError: 'Select at least one asset needing extraction.', manualRepairMessage: '' };
        render();
        return;
      }
      const rows = state.adminUi?.manualRepairRows || [];
      const rowsById = new Map(rows.map((row) => [row.assetId, row]));
      const total = selectedIds.length;
      let completed = 0;
      let succeeded = 0;
      let failed = 0;
      state.adminUi = {
        ...(state.adminUi || {}),
        manualRepairScanStatus: 'repairing',
        manualRepairMessage: `Repairing 0 of ${total}…`,
        manualRepairError: '',
        manualRepairProgress: { total, completed: 0, succeeded: 0, failed: 0, running: true }
      };
      render();
      const queue = [...selectedIds];
      const workerCount = Math.max(1, Math.min(Number(concurrency) || 3, 3));
      const worker = async () => {
        while (queue.length) {
          const nextId = queue.shift();
          if (!nextId) continue;
          const companyId = `${state.company?.id || ''}`.trim();
          try {
            const payload = companyId ? { assetId: nextId, companyId, dryRun: false } : { assetId: nextId, dryRun: false };
            const result = await repairAssetDocumentationState(payload);
            const entry = (result?.manualMaterialization?.entries || []).find((item) => item.assetId === nextId) || {};
            const merged = mergeMaterializationResultIntoRow(rowsById.get(nextId) || { assetId: nextId }, entry);
            rowsById.set(nextId, merged);
            succeeded += 1;
          } catch (error) {
            failed += 1;
            rowsById.set(nextId, mergeMaterializationResultIntoRow(rowsById.get(nextId) || { assetId: nextId }, {}, sanitizeRepairErrorMessage(error)));
          }
          completed += 1;
          upsertManualRepairRows(Array.from(rowsById.values()));
          state.adminUi = {
            ...(state.adminUi || {}),
            manualRepairMessage: `Repairing ${completed} of ${total}…`,
            manualRepairProgress: { total, completed, succeeded, failed, running: completed < total },
            manualRepairSummary: buildManualRepairSummary(Array.from(rowsById.values()))
          };
          render();
        }
      };
      await Promise.all(Array.from({ length: workerCount }, () => worker()));
      await refreshData();
      state.adminUi = {
        ...(state.adminUi || {}),
        manualRepairScanStatus: 'completed',
        manualRepairMessage: `Manual text repair complete. Succeeded ${succeeded}, failed ${failed}.`,
        manualRepairError: failed ? 'Some assets could not be repaired. See row details.' : '',
        manualRepairProgress: { total, completed, succeeded, failed, running: false },
        manualRepairRows: Array.from(rowsById.values()),
        manualRepairSummary: buildManualRepairSummary(Array.from(rowsById.values()))
      };
      render();
    }),
    downloadManualRepairResultsCsv: () => {
      const rows = state.adminUi?.manualRepairRows || [];
      if (!rows.length || typeof downloadFile !== 'function') return;
      const header = ['assetId', 'assetName', 'action', 'status', 'reason', 'chunkCount', 'extractionEngine', 'storagePath', 'error'];
      const escape = (value) => `"${`${value ?? ''}`.replace(/"/g, '""')}"`;
      const lines = rows.map((row) => [
        row.assetId,
        row.assetName,
        row.action,
        normalizeExtractionStatus(row, row),
        row.extractionReason || row.reason,
        Number(row.newChunkCount || row.currentChunkCount || 0),
        row.extractionEngine || '',
        row.storagePath || '',
        row.extractionError || row.runMessage || ''
      ].map(escape).join(','));
      downloadFile('manual-repair-results.csv', `${header.join(',')}\n${lines.join('\n')}`, 'text/csv;charset=utf-8');
    }
  };
}
