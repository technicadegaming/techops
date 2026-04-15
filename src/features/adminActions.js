import { buildUsageSummary, normalizeBillingAddress } from '../billing.js';
import { ASSET_CSV_TEMPLATE, buildAssetImportRow } from './assetIntake.js';

export function createAdminActions(deps) {
  const {
    state,
    render,
    refreshData,
    runAction,
    withRequiredCompanyId,
    upsertEntity,
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
    createCompanyInvite,
    revokeInvite
  } = deps;

  const setAdminFeedback = ({ tone = 'info', message = '' } = {}) => {
    state.adminUi = { ...(state.adminUi || {}), tone, message };
  };

  const setImportFeedback = ({ tone = 'info', summary = '', preview = '' } = {}) => {
    state.adminUi = { ...(state.adminUi || {}), importTone: tone, importSummary: summary, importPreview: preview };
    render();
  };

  return {
    setImportFeedback,
    setAdminSection: (section) => {
      state.adminSection = section || 'company';
      render();
    },    setAuditFilter: (category) => {
      state.adminUi = { ...(state.adminUi || {}), auditCategory: category || 'all' };
      render();
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
    createInvite: async ({ email, role }) => {
      await runAction('create_invite', async () => {
        const invite = await createCompanyInvite({ companyId: state.company.id, email, role, user: state.user });
        state.invites = [{
          id: invite.id,
          companyId: state.company.id,
          email: `${email || ''}`.trim().toLowerCase(),
          role,
          inviteCode: invite.inviteCode,
          token: invite.token,
          status: 'pending'
        }, ...(state.invites || []).filter((entry) => entry.id !== invite.id)];
        setAdminFeedback({ tone: 'success', message: `Invite created for ${`${email || ''}`.trim().toLowerCase()}. Share code ${invite.inviteCode}.` });
        render();
        await refreshData();
        render();
      }, { fallbackMessage: 'Unable to create invite.' });
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
      await runAction('update_company_profile', async () => {
        await upsertEntity('companies', state.company.id, withRequiredCompanyId({
          ...state.company,
          name: `${payload.name || state.company?.name || ''}`.trim(),
          primaryEmail: `${payload.primaryEmail || state.company?.primaryEmail || ''}`.trim(),
          primaryPhone: `${payload.primaryPhone || state.company?.primaryPhone || ''}`.trim(),
          timeZone: `${payload.timeZone || state.company?.timeZone || 'UTC'}`.trim(),
          businessType: `${payload.businessType || ''}`.trim(),
          industry: `${payload.industry || ''}`.trim(),
          logoUrl: `${payload.logoUrl || ''}`.trim(),
          hqStreet: `${payload.hqStreet || ''}`.trim(),
          hqCity: `${payload.hqCity || ''}`.trim(),
          hqState: `${payload.hqState || ''}`.trim(),
          hqZip: `${payload.hqZip || ''}`.trim()
        }, 'update company profile'), state.user);
        setAdminFeedback({ tone: 'success', message: 'Company profile settings saved.' });
        await refreshData();
        render();
      }, { fallbackMessage: 'Unable to update company profile.' });
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
    importAssets: async (rows) => {
      if (!rows.length) {
        setImportFeedback({ tone: 'error', summary: 'No asset rows were imported.', preview: state.adminUi?.importPreview || '' });
        return;
      }
      let imported = 0;
      let skipped = 0;
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
          normalizedName: row.normalizedName || '',
          manualUrl: row.manualUrl || '',
          manualSourceUrl: row.manualSourceUrl || '',
          supportEmail: row.supportEmail || '',
          supportPhone: row.supportPhone || '',
          supportUrl: row.supportUrl || '',
          matchConfidence: row.matchConfidence || '',
          matchNotes: row.matchNotes || ''
        });
        const id = `${mapped.assetId || normalizeAssetId(mapped['asset name'] || '')}`.trim();
        if (!id) {
          skipped += 1;
          continue;
        }
        const supportContacts = [];
        if (mapped.supportEmail) supportContacts.push({ contactType: 'email', label: 'Support email', value: mapped.supportEmail });
        if (mapped.supportPhone) supportContacts.push({ contactType: 'phone', label: 'Support phone', value: mapped.supportPhone });
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
          normalizedName: mapped.normalizedName || '',
          manualLinks: mapped.manualUrl ? [mapped.manualUrl] : [],
          manualSourceUrl: mapped.manualSourceUrl || '',
          supportResourcesSuggestion: mapped.supportUrl ? [{ url: mapped.supportUrl, label: 'Support resource' }] : [],
          supportContactsSuggestion: supportContacts,
          enrichmentConfidence: Number(mapped.matchConfidence || 0) || null,
          matchNotes: mapped.matchNotes || ''
        }, 'import assets'), state.user);
        imported += 1;
      }
      await upsertEntity('importHistory', `import-assets-${Date.now()}`, { type: 'assets', rowCount: rows.length }, state.user);
      setImportFeedback({ tone: imported ? 'success' : 'error', summary: `Assets import complete. Imported ${imported}${skipped ? `, skipped ${skipped}` : ''}.`, preview: state.adminUi?.importPreview || '' });
      setAdminFeedback({ tone: imported ? 'success' : 'error', message: imported ? `Imported ${imported} asset rows.` : 'No asset rows were imported.' });
      await refreshData();
      render();
    },
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
    }
  };
}
