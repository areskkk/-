import { createEnterpriseApplicationsPage } from './pages/applications.js';
import { createEnterpriseBindPage } from './pages/bind.js';
import { createEnterpriseDashboardPage } from './pages/dashboard.js';
import { createEnterpriseNotificationsPage } from './pages/notifications.js';
import { createEnterprisePoliciesPage } from './pages/policies.js';
import { createEnterpriseProfilePage } from './pages/profile.js';
import { createEnterpriseQaPage } from './pages/qa.js';
import { createEnterpriseSettingsPage } from './pages/settings.js';
import { createEnterpriseSupplementsPage } from './pages/supplements.js';
import { createEnterpriseUtilityPage } from './pages/utility.js';
import { createEnterpriseLayout } from './shared/layout.js';
import { createEnterpriseUi } from './shared/ui.js';

export function createEnterpriseFeature(deps) {
  const {
    apiFetch,
    getToken,
    loadCurrentUser,
    replace,
    roleGroups,
  } = deps;

  const layout = createEnterpriseLayout(deps);
  const ui = createEnterpriseUi(deps);
  const sharedDeps = { ...deps, ...layout, ...ui };
  const utilityPage = createEnterpriseUtilityPage(sharedDeps);
  const pageDeps = { ...sharedDeps, ...utilityPage };

  const { renderEnterpriseBind } = createEnterpriseBindPage(pageDeps);
  const { renderEnterpriseDashboard } = createEnterpriseDashboardPage(pageDeps);
  const { renderEnterpriseProfile } = createEnterpriseProfilePage(pageDeps);
  const { renderEnterpriseQa } = createEnterpriseQaPage(pageDeps);
  const { renderEnterprisePolicies, renderEnterprisePolicyDetail } = createEnterprisePoliciesPage(pageDeps);
  const {
    renderEnterpriseApplicationDetail,
    renderEnterpriseApplicationNew,
    renderEnterpriseApplications,
  } = createEnterpriseApplicationsPage(pageDeps);
  const { renderEnterpriseSupplement } = createEnterpriseSupplementsPage(pageDeps);
  const { renderEnterpriseNotifications } = createEnterpriseNotificationsPage(pageDeps);
  const { renderEnterpriseSettings } = createEnterpriseSettingsPage(pageDeps);
  const { renderEnterpriseUtility } = utilityPage;

  async function loadEnterpriseContext() {
    const user = await loadCurrentUser();
    const enterprises = await apiFetch('/enterprises/me').catch((error) => {
      if (error.code === 'FORBIDDEN' || error.status === 403) {
        return [];
      }
      throw error;
    });
    const approved = enterprises.filter((item) => (
      item.auth_status === 'agent_approved' || item.auth_status === 'manual_approved'
    ));
    const currentEnterprise = approved[0] || enterprises[0] || null;
    let profile = null;
    if (currentEnterprise && approved.length > 0) {
      profile = await apiFetch('/enterprise-profile')
        .then((data) => data.current_profile)
        .catch(() => null);
    }
    return { user, enterprises, approved, currentEnterprise, profile };
  }

  async function renderEnterprisePage(path) {
    if (!getToken()) {
      replace(`/login?redirect=${encodeURIComponent(path)}`);
      return;
    }
    const user = await loadCurrentUser();
    if (!roleGroups(user).some((role) => role.code === 'enterprise')) {
      replace('/403');
      return;
    }
    const context = await loadEnterpriseContext();

    if (path === '/enterprise/bind') return renderEnterpriseBind(user, context);
    if (path === '/enterprise/dashboard') return renderEnterpriseDashboard(user, context);
    if (path === '/enterprise/profile') return renderEnterpriseProfile(user, context);
    if (path === '/enterprise/qa') return renderEnterpriseQa(user, context);
    if (path === '/enterprise/policies') return renderEnterprisePolicies(user, context);
    if (path === '/enterprise/applications') return renderEnterpriseApplications(user, context);
    if (path === '/enterprise/applications/new') return renderEnterpriseApplicationNew(user, context);
    if (path === '/enterprise/notifications') return renderEnterpriseNotifications(user, context);
    if (path === '/enterprise/settings') return renderEnterpriseSettings(user, context);

    const policyMatch = path.match(/^\/enterprise\/policies\/([^/]+)$/);
    if (policyMatch) return renderEnterprisePolicyDetail(user, context, policyMatch[1]);
    const applicationMatch = path.match(/^\/enterprise\/applications\/([^/]+)$/);
    if (applicationMatch) return renderEnterpriseApplicationDetail(user, context, applicationMatch[1]);
    const supplementMatch = path.match(/^\/enterprise\/supplements\/([^/]+)$/);
    if (supplementMatch) return renderEnterpriseSupplement(user, context, supplementMatch[1]);

    renderEnterpriseUtility(user, context, '页面建设中', '当前企业端路由已接入权限和布局，功能将在后续批次完善。');
  }

  return { renderEnterprisePage };
}
