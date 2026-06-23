export function createEnterpriseProfilePage({
  app,
  apiFetch,
  enterpriseHero,
  enterpriseLayout,
  escapeHtml,
  hideAlert,
  navigate,
  profileCompleteness,
  progressBar,
  renderEnterpriseLocked,
  showAlert,
  toFriendlyError,
}) {
  function renderEnterpriseProfile(user, context) {
    if (context.approved.length === 0) {
      renderEnterpriseLocked(user, context, '企业画像维护', '企业画像需要绑定并审核通过企业主体后维护。');
      return;
    }
    const profile = context.profile || {};
    const profileJson = normalizeProfileJson(profile.profile_json);
    const completeness = profileCompleteness(profile) || 85;
    app.innerHTML = enterpriseLayout(user, context, `
      ${enterpriseHero('Enterprise Profile', '维护基础信息、经营数据、发展状态和扩展字段，支撑政策推荐、资格预判和申报预填。', `
        <a class="btn ghost" href="/enterprise/dashboard" data-link>返回工作台</a>
        <button class="btn primary" form="enterprise-profile-form" type="submit">保存画像</button>
      `, { kicker: 'Edit Profile' })}

      <div class="profile-layout">
        <aside class="profile-anchor-card enterprise-card">
          <div class="profile-company-mini">
            <strong>${escapeHtml(profile.enterprise_name || context.currentEnterprise.name || '新维创想科技有限公司')}</strong>
            <span>统一社会信用代码：${escapeHtml(profile.credit_code || context.currentEnterprise.credit_code || '91440300MA5EXXXX7Y')}</span>
          </div>
          <div class="overview-progress compact-progress">
            <div><strong>画像完整度 ${completeness}%</strong><span>自动保存已开启</span></div>
            ${progressBar(completeness, '画像完整度')}
          </div>
          <nav class="profile-anchor-nav" aria-label="企业画像分区">
            <a href="#profile-basic">基础信息</a>
            <a href="#profile-finance">经营数据</a>
            <a href="#profile-status">发展状态</a>
            <a href="#profile-extended">扩展字段</a>
          </nav>
        </aside>

        <section class="profile-main">
          <div id="form-alert" class="alert"></div>
          <form id="enterprise-profile-form" class="profile-form">
            <section id="profile-basic" class="enterprise-card profile-section">
              <div class="section-head"><h2>基础信息</h2><span>Basic Information</span></div>
              <div class="enterprise-form-grid">
                <div class="field"><label>企业名称</label><input name="enterpriseName" value="${escapeHtml(profile.enterprise_name || context.currentEnterprise.name || '')}"></div>
                <div class="field"><label>统一社会信用代码</label><input name="creditCode" value="${escapeHtml(profile.credit_code || context.currentEnterprise.credit_code || '')}"></div>
                <div class="field"><label>法定代表人</label><input name="legalPerson" value="${escapeHtml(profileJson.legal_person || '李明')}"></div>
                <div class="field"><label>注册资本</label><input name="registeredCapital" value="${escapeHtml(profileJson.registered_capital || '1000 万元')}"></div>
                <div class="field"><label>所属行业</label><input name="industry" value="${escapeHtml(profile.industry || '')}" placeholder="如：软件和信息技术服务业"></div>
                <div class="field"><label>企业规模</label><input name="scale" value="${escapeHtml(profile.scale || '')}" placeholder="小型 / 中型 / 大型"></div>
              </div>
            </section>

            <section id="profile-finance" class="enterprise-card profile-section">
              <div class="section-head"><h2>经营数据</h2><span>金额单位：万元</span></div>
              <div class="enterprise-form-grid">
                <div class="field"><label>年度营业收入</label><input name="revenue" type="number" value="${escapeHtml(profile.revenue_amount || '')}"></div>
                <div class="field"><label>净利润</label><input name="profit" type="number" value="${escapeHtml(profileJson.net_profit || '')}"></div>
                <div class="field"><label>纳税总额</label><input name="tax" type="number" value="${escapeHtml(profile.tax_amount || '')}"></div>
                <div class="field"><label>研发投入占比</label><input name="rdRatio" value="${escapeHtml(profileJson.rd_ratio || '12%')}"></div>
                <div class="field"><label>员工人数</label><input name="employees" type="number" value="${escapeHtml(profile.employee_count || '')}"></div>
                <div class="field"><label>出口额</label><input name="exportAmount" type="number" value="${escapeHtml(profile.export_amount || '')}"></div>
              </div>
            </section>

            <section id="profile-status" class="enterprise-card profile-section">
              <div class="section-head"><h2>发展状态</h2><span>Qualification Status</span></div>
              <div class="status-card-grid">
                <article class="status-check-card approved"><strong>高新技术企业认证</strong><span>已认证 · 2026 年到期</span></article>
                <article class="status-check-card warning"><strong>专精特新“小巨人”企业</strong><span>材料准备中 · 建议补充专利数据</span></article>
              </div>
              <div class="enterprise-form-grid section-form-gap">
                <div class="field"><label>专利总数</label><input name="patents" type="number" value="${escapeHtml(profileJson.patents || '')}"></div>
                <div class="field"><label>技改状态</label><input name="tech" value="${escapeHtml(profile.tech_upgrade_status || '')}" placeholder="如：已完成智能化改造"></div>
              </div>
            </section>

            <section id="profile-extended" class="enterprise-card profile-section">
              <div class="section-head"><h2>扩展字段</h2><button class="text-action" id="add-profile-field" type="button">添加自定义字段</button></div>
              <div id="custom-profile-fields" class="enterprise-form-grid">
                ${renderCustomFields(profileJson.custom_fields || [])}
              </div>
            </section>
          </form>
        </section>
      </div>
    `);
    bindEnterpriseProfileForm(context);
    bindProfileCustomFields();
  }

  function renderCustomFields(fields) {
    if (!fields.length) {
      return `
        <div class="field"><label>核心产品</label><input name="customKey" value="核心产品"></div>
        <div class="field"><label>字段内容</label><input name="customValue" value="智能政务协同平台"></div>
      `;
    }
    return fields.map((item) => `
      <div class="field"><label>字段名称</label><input name="customKey" value="${escapeHtml(item.key || '')}"></div>
      <div class="field"><label>字段内容</label><input name="customValue" value="${escapeHtml(item.value || '')}"></div>
    `).join('');
  }

  function bindProfileCustomFields() {
    document.querySelector('#add-profile-field')?.addEventListener('click', () => {
      document.querySelector('#custom-profile-fields')?.insertAdjacentHTML('beforeend', `
        <div class="field"><label>字段名称</label><input name="customKey" placeholder="如：海外市场"></div>
        <div class="field"><label>字段内容</label><input name="customValue" placeholder="请输入字段内容"></div>
      `);
    });
  }

  function bindEnterpriseProfileForm(context) {
    const form = document.querySelector('#enterprise-profile-form');
    form?.addEventListener('submit', async (event) => {
      event.preventDefault();
      hideAlert();
      const button = document.querySelector('button[form="enterprise-profile-form"]') || form.querySelector('button[type="submit"]');
      button.disabled = true;
      button.textContent = '保存中';
      try {
        await apiFetch('/enterprise-profile', {
          method: 'PUT',
          body: JSON.stringify({
            enterprise_id: context.currentEnterprise.enterprise_id,
            enterprise_name: form.enterpriseName.value.trim(),
            credit_code: form.creditCode.value.trim().toUpperCase(),
            industry: form.industry.value.trim(),
            scale: form.scale.value.trim(),
            revenue_amount: Number(form.revenue.value || 0),
            employee_count: Number(form.employees.value || 0),
            tax_amount: Number(form.tax.value || 0),
            export_amount: Number(form.exportAmount.value || 0),
            tech_upgrade_status: form.tech.value.trim(),
            profile_json: {
              legal_person: form.legalPerson.value.trim(),
              registered_capital: form.registeredCapital.value.trim(),
              net_profit: Number(form.profit.value || 0),
              rd_ratio: form.rdRatio.value.trim(),
              patents: Number(form.patents.value || 0),
              custom_fields: collectCustomFields(form),
            },
          }),
        });
        navigate('/enterprise/profile');
      } catch (error) {
        showAlert(toFriendlyError(error));
      } finally {
        button.disabled = false;
        button.textContent = '保存画像';
      }
    });
  }

  function collectCustomFields(form) {
    const keys = [...form.querySelectorAll('input[name="customKey"]')];
    const values = [...form.querySelectorAll('input[name="customValue"]')];
    return keys.map((key, index) => ({
      key: key.value.trim(),
      value: values[index]?.value.trim() || '',
    })).filter((item) => item.key || item.value);
  }

  function normalizeProfileJson(value) {
    if (!value) {
      return {};
    }
    if (typeof value === 'object') {
      return value;
    }
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }

  return { renderEnterpriseProfile };
}
