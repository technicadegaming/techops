import { canDelete, canEditAssets } from '../roles.js';

export function renderAssets(el, state, actions) {
  const editable = canEditAssets(state.profile);
  el.innerHTML = `
    <h2>Assets</h2>
    <form id="assetForm" class="grid grid-2">
      <input name="id" placeholder="Asset ID" required ${editable ? '' : 'disabled'} />
      <input name="name" placeholder="Asset name" required ${editable ? '' : 'disabled'} />
      <input name="status" placeholder="status" ${editable ? '' : 'disabled'} />
      <textarea name="historyNote" placeholder="History note (added to asset history)" ${editable ? '' : 'disabled'}></textarea>
      <button class="primary" ${editable ? '' : 'disabled'}>Save asset</button>
    </form>
    <div class="list">${state.assets.map((a) => `<div class="item"><b>${a.name || a.id}</b> · ${a.status || 'active'}
    <div class="tiny">History entries: ${(a.history || []).length}</div>
    ${canDelete(state.profile) ? `<button data-del="${a.id}" class="danger">Delete</button>` : ''}
    </div>`).join('')}</div>`;
  const form = el.querySelector('#assetForm');
  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const p = Object.fromEntries(fd.entries());
    actions.saveAsset(p.id, p);
    form.reset();
  });
  el.querySelectorAll('[data-del]').forEach((btn) => btn.addEventListener('click', () => actions.deleteAsset(btn.dataset.del)));
}
