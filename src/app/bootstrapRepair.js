import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-functions.js';
import { functions } from '../firebase.js';
import { buildOnboardingRepairPlan } from '../features/onboardingStatus.js';

const finalizeOnboardingBootstrapCallable = httpsCallable(functions, 'finalizeOnboardingBootstrap');

export function shouldFinalizeOnboardingBootstrap(state = {}) {
  return buildOnboardingRepairPlan(state).needsRepair;
}

export async function finalizeOnboardingBootstrap(state = {}) {
  const plan = buildOnboardingRepairPlan(state);
  if (!plan.needsRepair) return { repaired: false, reason: 'not_needed', plan };

  const result = await finalizeOnboardingBootstrapCallable({ companyId: plan.resolved.companyId });
  return { repaired: true, reason: 'callable_applied', plan, result: result?.data || null };
}
