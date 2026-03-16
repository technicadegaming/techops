export const TRIAL_LENGTH_DAYS = 14;

function addDays(date, days) {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + days);
  return next;
}

export function buildInitialBillingScaffold({ primaryEmail = '', displayName = '' } = {}) {
  const now = new Date();
  return {
    trialStatus: 'active',
    trialStartedAt: now.toISOString(),
    trialEndsAt: addDays(now, TRIAL_LENGTH_DAYS).toISOString(),
    subscriptionStatus: 'trialing',
    planKey: 'starter_trial',
    billingEmail: `${primaryEmail || ''}`.trim().toLowerCase(),
    billingContactName: `${displayName || ''}`.trim(),
    billingAddress: {
      line1: '',
      line2: '',
      city: '',
      state: '',
      postalCode: '',
      country: ''
    },
    seatLimit: null,
    usageSummary: {
      seatsUsed: 0,
      seatsLimit: null,
      members: 0,
      workers: 0,
      locations: 0,
      assets: 0,
      lastComputedAt: now.toISOString()
    }
  };
}

export function normalizeBillingAddress(address = {}) {
  return {
    line1: `${address.line1 || ''}`.trim(),
    line2: `${address.line2 || ''}`.trim(),
    city: `${address.city || ''}`.trim(),
    state: `${address.state || ''}`.trim(),
    postalCode: `${address.postalCode || ''}`.trim(),
    country: `${address.country || ''}`.trim()
  };
}

export function buildUsageSummary({ members = [], workers = [], locations = [], assets = [], seatLimit = null } = {}) {
  const seatsUsed = (Array.isArray(members) ? members : []).filter((member) => (member.status || 'active') === 'active').length;
  const cleanSeatLimit = Number.isFinite(Number(seatLimit)) && Number(seatLimit) > 0 ? Number(seatLimit) : null;
  return {
    seatsUsed,
    seatsLimit: cleanSeatLimit,
    members: Array.isArray(members) ? members.length : 0,
    workers: Array.isArray(workers) ? workers.length : 0,
    locations: Array.isArray(locations) ? locations.length : 0,
    assets: Array.isArray(assets) ? assets.length : 0,
    lastComputedAt: new Date().toISOString()
  };
}

export function isTrialExpired(trialEndsAt) {
  if (!trialEndsAt) return false;
  const ends = new Date(trialEndsAt).getTime();
  if (Number.isNaN(ends)) return false;
  return Date.now() > ends;
}

export function getTrialDaysRemaining(trialEndsAt) {
  if (!trialEndsAt) return null;
  const ends = new Date(trialEndsAt).getTime();
  if (Number.isNaN(ends)) return null;
  const diff = ends - Date.now();
  return Math.ceil(diff / (24 * 60 * 60 * 1000));
}
