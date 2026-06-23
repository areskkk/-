export function createEnterprisePoliciesPage({
  app,
  apiFetch,
  emptyBlock,
  enterpriseHero,
  enterpriseLayout,
  escapeHtml,
  policyCard,
  renderEnterpriseUtility,
  toFriendlyError,
}) {
  async function renderEnterprisePolicies(user, context) {
    const policies = await apiFetch('/policies?page_size=20').catch(() => ({ items: [] }));
    app.innerHTML = enterpriseLayout(user, context, `
      ${enterpriseHero('政策推荐', '查看可申报政策，结合企业画像进行资格预判和申报发起。')}
      <section class="enterprise-card policy-list">
        ${(policies.items || []).map(policyCard).join('') || emptyBlock('暂无政策', '当前没有已发布政策。')}
      </section>
    `);
  }

  async function renderEnterprisePolicyDetail(user, context, policyId) {
    const policy = await apiFetch(`/policies/${policyId}`).catch((error) => ({ error }));
    if (policy.error) {
      renderEnterpriseUtility(user, context, '政策不存在', toFriendlyError(policy.error));
      return;
    }
    app.innerHTML = enterpriseLayout(user, context, `
      ${enterpriseHero('政策详情', '查看政策摘要、申报条件、材料要求和办理入口。', `<a class="btn primary" href="/enterprise/applications/new?policy_id=${policy.policy_id}" data-link>开始申报</a>`)}
      <div class="enterprise-grid detail">
        <section class="enterprise-card policy-detail-main">
          <div class="section-head">
            <div>
              <span>政策名称</span>
              <h2>${escapeHtml(policy.title)}</h2>
            </div>
            <b class="status-badge ${policy.status}">${escapeHtml(policy.status || 'effective')}</b>
          </div>
          <div class="meta-list">
            <div class="meta-item"><span class="meta-label">来源</span><span class="meta-value">${escapeHtml(policy.source_name || '未填写')}</span></div>
            <div class="meta-item"><span class="meta-label">版本</span><span class="meta-value">${escapeHtml(policy.version || 'v1')}</span></div>
            <div class="meta-item"><span class="meta-label">生效日期</span><span class="meta-value">${escapeHtml(policy.effective_date || '未填写')}</span></div>
            <div class="meta-item"><span class="meta-label">截止日期</span><span class="meta-value">${escapeHtml(policy.expire_date || '未填写')}</span></div>
          </div>
          <h2>政策摘要</h2>
          <p class="detail-copy">${escapeHtml(policy.content || '该政策暂未录入正文，请联系政策管理员补充。')}</p>
        </section>
        <aside class="enterprise-card">
          <h2>下一步操作</h2>
          <div class="action-stack">
            <a class="btn primary full" href="/enterprise/applications/new?policy_id=${policy.policy_id}" data-link>创建申报草稿</a>
            <a class="btn ghost full" href="/enterprise/qa" data-link>咨询该政策</a>
            <a class="btn ghost full" href="/enterprise/profile" data-link>完善企业画像</a>
          </div>
        </aside>
      </div>
    `);
  }

  return { renderEnterprisePolicies, renderEnterprisePolicyDetail };
}
