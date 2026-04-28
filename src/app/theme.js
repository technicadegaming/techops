const STORAGE_KEY = 'techops.appearance.v1';

const PRESETS = {
  scoot_default: { bg: '#f4f6fb', surface: '#ffffff', text: '#14202b', muted: '#5d6c7f', primary: '#0f172a', accent: '#1d4ed8', border: '#d8dee8' },
  blue: { bg: '#eff6ff', surface: '#ffffff', text: '#0f172a', muted: '#475569', primary: '#1d4ed8', accent: '#2563eb', border: '#c7d2fe' },
  green: { bg: '#ecfdf5', surface: '#ffffff', text: '#052e16', muted: '#14532d', primary: '#166534', accent: '#16a34a', border: '#bbf7d0' },
  purple: { bg: '#f5f3ff', surface: '#ffffff', text: '#2e1065', muted: '#5b21b6', primary: '#6d28d9', accent: '#7c3aed', border: '#ddd6fe' },
  red_burgundy: { bg: '#fff1f2', surface: '#ffffff', text: '#4c0519', muted: '#881337', primary: '#9f1239', accent: '#be123c', border: '#fecdd3' },
  orange: { bg: '#fff7ed', surface: '#ffffff', text: '#431407', muted: '#9a3412', primary: '#c2410c', accent: '#ea580c', border: '#fed7aa' },
  dark_slate: { bg: '#0f172a', surface: '#1e293b', text: '#e2e8f0', muted: '#cbd5e1', primary: '#f8fafc', accent: '#38bdf8', border: '#334155' },
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
  const parseHexChannel = (hex = '', start = 0) => Number.parseInt(hex.slice(start, start + 2), 16) / 255;
  const getRelativeLuminance = (hex = '#000000') => {
    const normalized = `${hex || ''}`.trim().replace('#', '');
    if (!/^[0-9a-f]{6}$/i.test(normalized)) return 0;
    const channels = [parseHexChannel(normalized, 0), parseHexChannel(normalized, 2), parseHexChannel(normalized, 4)].map((value) => (
      value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    ));
    return (0.2126 * channels[0]) + (0.7152 * channels[1]) + (0.0722 * channels[2]);
  };
  const getContrast = (a, b) => {
    const [light, dark] = [getRelativeLuminance(a), getRelativeLuminance(b)].sort((x, y) => y - x);
    return (light + 0.05) / (dark + 0.05);
  };
  const pickReadableText = (bg, preferred, fallback) => (getContrast(bg, preferred) >= 4.5 ? preferred : fallback);
  const root = document.documentElement;
  const systemDark = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const effectiveDark = pref.mode === 'dark' || (pref.mode === 'system' && systemDark);
  const base = { ...(PRESETS[pref.preset] || PRESETS.scoot_default), ...(effectiveDark ? DARK_OVERRIDES : {}) };
  const custom = pref.customColors || {};
  const primary = custom.primary || base.primary;
  const accent = custom.accent || base.accent || base.primary;
  const bg = custom.background || base.bg;
  const text = custom.text || base.text;
  const readableText = pickReadableText(bg, text, getContrast(bg, '#0b1220') >= getContrast(bg, '#f8fafc') ? '#0b1220' : '#f8fafc');
  const primaryText = pickReadableText(primary, effectiveDark ? '#0b1220' : '#ffffff', effectiveDark ? '#f8fafc' : '#0b1220');
  root.style.setProperty('--color-bg', bg);
  root.style.setProperty('--color-surface', base.surface);
  root.style.setProperty('--color-text', readableText);
  root.style.setProperty('--color-muted', base.muted);
  root.style.setProperty('--color-primary', primary);
  root.style.setProperty('--color-primary-text', primaryText);
  root.style.setProperty('--color-border', base.border);
  root.style.setProperty('--accent', accent);
  root.style.setProperty('--accent-2', accent);
  root.style.setProperty('--color-danger', '#b91c1c');
  root.style.setProperty('--color-success', '#166534');
  root.style.setProperty('--color-warning', '#b45309');
  root.dataset.themeMode = effectiveDark ? 'dark' : 'light';
  root.dataset.motion = pref.motion || 'standard';
  root.dataset.contrast = pref.contrast || 'standard';
  root.dataset.textSize = pref.textSize || 'comfortable';
}
