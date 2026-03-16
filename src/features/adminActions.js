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
    },
    saveWorker: async (id, payload) => {
      const existing = state.workers.find((worker) => worker.id === id) || {};
      await upsertEntity('workers', id, { ...existing, ...payload, accountStatus: existing.accountStatus || (payload.email ? 'invited_or_unlinked' : 'directory_only') }, state.user);
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
    downloadAssetTemplate: () => downloadFile('asset-template.csv', 'asset name,assetId,manufacturer,model,serial,location,zone,notes,category,status\n', 'text/csv'),
    downloadEmployeeTemplate: () => downloadFile('employee-template.csv', 'name,email,role,enabled,available,shift start,skills,location,phone\n', 'text/csv'),
    importAssets: async (rows) => {
      if (!rows.length) {
        setImportFeedback({ tone: 'error', summary: 'No asset rows were imported.', preview: state.adminUi?.importPreview || '' });
        return;
      }
      let imported = 0;
      let skipped = 0;
      for (const row of rows) {
        const id = `${row.assetId || row.id || normalizeAssetId(row['asset name'] || row.name || '')}`;
        if (!id) {
          skipped += 1;
          continue;
        }
        await upsertEntity('assets', id, withRequiredCompanyId({
          id,
          name: row['asset name'] || row.name || id,
          manufacturer: row.manufacturer || '',
          model: row.model || '',
          serialNumber: row.serial || row.serialNumber || '',
          locationName: row.location || '',
          zone: row.zone || row.area || '',
          notes: row.notes || '',
          category: row.category || row.type || '',
          status: row.status || 'active'
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
    exportBackup: async () => downloadJson(`wow-backup-${Date.now()}.json`, await exportBackupJson()),
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
    }
  };
}
