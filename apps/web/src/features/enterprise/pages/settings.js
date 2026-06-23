import { bindingStatusLabels, statusText, userTypeLabels } from '../shared/status.js';

export function createEnterpriseSettingsPage({
  app,
  enterpriseHero,
  enterpriseLayout,
  escapeHtml,
}) {
  function renderEnterpriseSettings(user, context) {
    app.innerHTML = enterpriseLayout(user, context, `
      ${enterpriseHero('账号与企业设置', '查看当前账号、企业绑定状态和基础偏好。')}
      <div class="enterprise-grid two">
        <section class="enterprise-card">
          <h2>个人账号</h2>
          <div class="meta-list">
            <div class="meta-item"><span class="meta-label">姓名</span><span class="meta-value">${escapeHtml(user.name || '未填写')}</span></div>
            <div class="meta-item"><span class="meta-label">手机号</span><span class="meta-value">${escapeHtml(user.phone || '未填写')}</span></div>
            <div class="meta-item"><span class="meta-label">账号类型</span><span class="meta-value">${escapeHtml(userTypeLabels[user.user_type] || user.user_type || '未知')}</span></div>
          </div>
        </section>
        <section class="enterprise-card">
          <h2>当前企业</h2>
          <div class="meta-list">
            <div class="meta-item"><span class="meta-label">企业名称</span><span class="meta-value">${escapeHtml(context.currentEnterprise?.name || '未绑定')}</span></div>
            <div class="meta-item"><span class="meta-label">信用代码</span><span class="meta-value">${escapeHtml(context.currentEnterprise?.credit_code || '未填写')}</span></div>
            <div class="meta-item"><span class="meta-label">绑定状态</span><span class="meta-value">${escapeHtml(statusText(context.currentEnterprise?.auth_status, bindingStatusLabels))}</span></div>
          </div>
        </section>
      </div>
    `);
  }

  return { renderEnterpriseSettings };
}
