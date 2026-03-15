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

  return {
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
      await upsertEntity('workers', id, {
        id,
        displayName: `${payload.displayName || ''}`.trim(),
        email: `${payload.email || ''}`.trim().toLowerCase(),
        role: payload.role || 'staff',
        enabled: true,
        available: true,
        skills: `${payload.skills || ''}`.split(/[|,;]+/).map((value) => value.trim()).filter(Boolean),
        inviteStatus: 'not_invited',
        accountStatus: payload.email ? 'unlinked' : 'directory_only',
        phone: '',
        defaultLocationId: `${payload.defaultLocationId || ''}`.trim(),
        locationName: `${payload.locationName || ''}`.trim()
      }, state.user);
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
        render();
        alert(`Invite created. Share code: ${invite.inviteCode}`);
        await refreshData();
        render();
      }, { fallbackMessage: 'Unable to create invite.' });
    },
    revokeInvite: async (inviteId) => {
      await revokeInvite(inviteId, state.user);
      await refreshData();
      render();
    },
    addLocation: async (payload) => {
      const id = `loc-${Date.now().toString(36)}`;
      await runAction('add_location', async () => {
        await upsertEntity('companyLocations', id, withRequiredCompanyId({ id, ...payload }, 'add a company location'), state.user);
        await refreshData();
        render();
      }, { fallbackMessage: 'Unable to add company location.' });
    },
    downloadAssetTemplate: () => downloadFile('asset-template.csv', 'asset name,assetId,manufacturer,model,serial,location,zone,notes,category,status\n', 'text/csv'),
    downloadEmployeeTemplate: () => downloadFile('employee-template.csv', 'name,email,role,enabled,available,shift start,skills,location,phone\n', 'text/csv'),
    importAssets: async (rows) => {
      for (const row of rows) {
        const id = `${row.assetId || row.id || normalizeAssetId(row['asset name'] || row.name || '')}`;
        if (!id) continue;
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
      }
      await upsertEntity('importHistory', `import-assets-${Date.now()}`, { type: 'assets', rowCount: rows.length }, state.user);
      await refreshData();
      render();
    },
    importEmployees: async (rows) => {
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
      }
      await upsertEntity('importHistory', `import-employees-${Date.now()}`, { type: 'employees', rowCount: rows.length }, state.user);
      await refreshData();
      render();
    },
    exportBackup: async () => downloadJson(`wow-backup-${Date.now()}.json`, await exportBackupJson()),
    clearTasks: async () => {
      const tasksCleared = await clearEntitySet('tasks', state.user);
      const operationsCleared = await clearEntitySet('operations', state.user);
      alert(`Cleared ${tasksCleared} tasks and ${operationsCleared} operations.`);
      await refreshData();
      render();
    },
    clearAssets: async () => {
      const count = await clearEntitySet('assets', state.user);
      alert(`Cleared ${count} assets.`);
      await refreshData();
      render();
    },
    clearWorkers: async () => {
      const count = await clearEntitySet('workers', state.user, (worker) => (worker.email || '').toLowerCase() !== (state.user.email || '').toLowerCase());
      alert(`Cleared ${count} worker directory entries.`);
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
      alert('Workspace reset complete. Company profile, owner membership, and locations were kept.');
      await refreshData();
      render();
    },
    saveAISettings: async (settings) => {
      await saveAppSettings(settings, state.user);
      await refreshData();
      render();
    }
  };
}
