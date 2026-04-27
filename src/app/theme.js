const STORAGE_KEY = 'techops.appearance.v1';

const PRESETS = {
  scoot_default: { bg: '#f4f6fb', surface: '#ffffff', text: '#14202b', muted: '#5d6c7f', primary: '#0f172a', accent: '#1d4ed8', border: '#d8dee8' },
  high_contrast: { bg: '#ffffff', surface: '#ffffff', text: '#000000', muted: '#111827', primary: '#000000', accent: '#0037ff', border: '#111111' },
  soft_blue: { bg: '#eef4ff', surface: '#ffffff', text: '#0b1f3a', muted: '#47607e', primary: '#123b8f', accent: '#2f6ee5', border: '#bfd1ee' },
  warm_neutral: { bg: '#f7f2eb', surface: '#fffaf4', text: '#2b2620', muted: '#6b5f52', primary: '#4f3722', accent: '#b7791f', border: '#d9cfc4' },
  green_operations: { bg: '#eef8f2', surface: '#ffffff', text: '#133222', muted: '#3f6a54', primary: '#14532d', accent: '#16a34a', border: '#b8ddc8' },
  company_brand: { bg: '#f4f6fb', surface: '#ffffff', text: '#14202b', muted: '#5d6c7f', primary: '#0f172a', accent: '#1d4ed8', border: '#d8dee8' }
};

const DARK_OVERRIDES = { bg: '#0b1220', surface: '#121b2b', text: '#e5eefb', muted: '#9bb0cf', primary: '#e2e8f0', accent: '#60a5fa', border: '#314258' };

export function getDefaultAppearance() {
  return {
    mode: 'system',
    preset: 'scoot_default',
    textSize: 'comfortable',
    contrast: 'standard',
    motion: 'standard',
    customColors: { primary: '', accent: '', background: '', text: '' }
  };
}

export function loadAppearancePreference() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return { ...getDefaultAppearance(), ...parsed, customColors: { ...getDefaultAppearance().customColors, ...(parsed.customColors || {}) } };
  } catch {
    return getDefaultAppearance();
  }
}

export function persistAppearancePreference(value) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
}

export function applyAppearancePreference(pref = getDefaultAppearance()) {
  const root = document.documentElement;
  const systemDark = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const effectiveDark = pref.mode === 'dark' || (pref.mode === 'system' && systemDark);
  const base = { ...(PRESETS[pref.preset] || PRESETS.scoot_default), ...(effectiveDark ? DARK_OVERRIDES : {}) };
  const custom = pref.customColors || {};
  const primary = custom.primary || base.primary;
  const bg = custom.background || base.bg;
  const text = custom.text || base.text;
  root.style.setProperty('--color-bg', bg);
  root.style.setProperty('--color-surface', base.surface);
  root.style.setProperty('--color-text', text);
  root.style.setProperty('--color-muted', base.muted);
  root.style.setProperty('--color-primary', primary);
  root.style.setProperty('--color-primary-text', effectiveDark ? '#0b1220' : '#ffffff');
  root.style.setProperty('--color-border', base.border);
  root.style.setProperty('--color-danger', '#b91c1c');
  root.style.setProperty('--color-success', '#166534');
  root.style.setProperty('--color-warning', '#b45309');
  root.dataset.themeMode = effectiveDark ? 'dark' : 'light';
  root.dataset.motion = pref.motion || 'standard';
  root.dataset.contrast = pref.contrast || 'standard';
  root.dataset.textSize = pref.textSize || 'comfortable';
}
