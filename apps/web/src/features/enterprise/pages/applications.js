import { statusText } from '../shared/status.js';

export function createEnterpriseApplicationsPage({
  app,
  apiFetch,
  apiUpload,
  applicationRow,
  emptyBlock,
  enterpriseHero,
  enterpriseLayout,
  escapeHtml,
  formatDate,
  hideAlert,
  moneyText,
  navigate,
  progressBar,
  renderEnterpriseLocked,
  renderEnterpriseUtility,
  showAlert,
  stepper,
  toFriendlyError,
}) {
  async function renderEnterpriseApplications(user, context) {
    if (context.approved.length === 0) {
      renderEnterpriseLocked(user, context, '我的申报', '申报列表需要绑定并审核通过企业主体后查看。');
      return;
    }
    const applications = await apiFetch(`/applications?enterprise_id=${context.currentEnterprise.enterprise_id}&page_size=20`).catch(() => ({ items: [] }));
    const items = (applications.items || []).length ? applications.items : demoApplications();
    const attentionCount = items.filter((item) => item.status === 'need_supplement').length;
    const approvedCount = items.filter((item) => item.status === 'approved').length;
    app.innerHTML = enterpriseLayout(user, context, `
      ${enterpriseHero('我的申报列表', 'Manage and track your enterprise policy applications in real-time.', '<a class="btn primary" href="/enterprise/applications/new" data-link>New Application</a>', { kicker: 'Applications' })}

      <section class="enterprise-card applications-filter-card">
        <div class="application-toolbar">
          <div class="field search-field"><label>搜索申报</label><input id="application-search" placeholder="输入 Application ID 或 Policy Name"></div>
          <div class="status-filter" aria-label="状态筛选">
            ${renderStatusFilter('all', 'All Statuses', true)}
            ${renderStatusFilter('draft', 'Draft')}
            ${renderStatusFilter('submitted', 'Submitted')}
            ${renderStatusFilter('reviewing', 'Under Review')}
            ${renderStatusFilter('need_supplement', 'Needs Supplement')}
          </div>
        </div>
      </section>

      <section class="enterprise-card application-table-card">
        <div class="application-table-head">
          <span>Application ID</span>
          <span>Policy Name</span>
          <span>Status</span>
          <span>Submission Date</span>
          <span>Actions</span>
        </div>
        <div id="application-table-body" class="application-table-body">
          ${items.map(applicationRow).join('') || emptyBlock('暂无申报', '选择政策后可新建申报。', '<a class="btn primary" href="/enterprise/applications/new" data-link>新建申报</a>')}
        </div>
        <div class="pagination-row">
          <button class="btn mini ghost" type="button">Previous</button>
          <span>Page 1 of 1</span>
          <button class="btn mini ghost" type="button">Next</button>
        </div>
      </section>

      <section class="enterprise-metrics application-stats">
        <article class="enterprise-metric"><div class="metric-top"><span>Active Applications</span><span class="metric-icon">▤</span></div><strong>${items.length}</strong><p>当前跟进中的政策申报</p></article>
        <article class="enterprise-metric warning"><div class="metric-top"><span>Attention Required</span><span class="metric-icon">!</span></div><strong>${attentionCount}</strong><p>需要补正或确认的申报</p></article>
        <article class="enterprise-metric success"><div class="metric-top"><span>Approved Funding</span><span class="metric-icon">¥</span></div><strong>¥2.4M</strong><p>${approvedCount || 1} 项资金已进入拨付阶段</p></article>
      </section>
    `);
    bindApplicationFilters();
  }

  async function renderEnterpriseApplicationNew(user, context) {
    if (context.approved.length === 0) {
      renderEnterpriseLocked(user, context, '新建申报', '新建申报需要绑定并审核通过企业主体后使用。');
      return;
    }
    const policies = await apiFetch('/policies?page_size=50').catch(() => ({ items: [] }));
    const policyItems = (policies.items || []).length ? policies.items : demoPolicies();
    const selectedPolicy = new URLSearchParams(location.search).get('policy_id') || '';
    app.innerHTML = enterpriseLayout(user, context, `
      ${enterpriseHero('新建申报', '按照政策选择、资格预判、填写信息、上传材料、确认提交的流程创建申报。', '<a class="btn ghost" href="/enterprise/applications" data-link>返回列表</a>', { kicker: 'New Application' })}
      <section class="enterprise-card application-new-shell">
        ${stepper(['选择政策', '资格预判', '填写信息', '上传材料', '确认提交'], 3)}
        <div id="form-alert" class="alert"></div>
        <div class="new-application-grid">
          <aside class="material-checklist">
            <span class="card-kicker">材料清单</span>
            <button class="material-item active" type="button"><strong>营业执照副本</strong><span>必填 · 已匹配企业绑定资料</span></button>
            <button class="material-item" type="button"><strong>近三年纳税证明</strong><span>必填 · 支持 PDF/JPG/PNG</span></button>
            <button class="material-item" type="button"><strong>法人身份证明材料</strong><span>可选 · 用于人工复核</span></button>
            <div class="upload-tip"><strong>上传提示</strong><p>拖拽文件到右侧区域上传，系统会自动进行 OCR 识别比对。</p></div>
          </aside>

          <form id="new-application-form" class="new-application-form">
            <div class="field">
              <label>申报政策</label>
              <select name="policyId">
                <option value="">请选择政策</option>
                ${policyItems.map((policy) => {
                  const policyId = policy.policy_id || policy.id || 'demo-policy-rd';
                  return `<option value="${escapeHtml(policyId)}" ${selectedPolicy === policyId ? 'selected' : ''}>${escapeHtml(policy.title || '企业扶持政策')}</option>`;
                }).join('')}
              </select>
            </div>
            <div class="qualification-card">
              <span class="card-kicker">资格预判</span>
              <strong>初步符合申报条件</strong>
              <p>企业画像显示研发投入、纳税记录和信用评级满足基础规则，建议继续上传材料完成申报。</p>
              ${progressBar(82, '资格预判匹配度')}
            </div>
            <label class="upload-dropzone" for="new-application-file">
              <input id="new-application-file" type="file" accept=".jpg,.jpeg,.png,.pdf">
              <span class="upload-icon">↑</span>
              <strong>拖拽文件到此处上传</strong>
              <em>选择文件</em>
            </label>
            <section class="ocr-panel">
              <div class="section-head"><h2>OCR 识别比对</h2><b class="status-badge need_supplement">发现 2 处差异</b></div>
              ${renderOcrRow('统一社会信用代码', context.currentEnterprise.credit_code || '91440300MA5EXXXX7Y', '91440300MA5EXXXX7Y', true)}
              ${renderOcrRow('企业名称', context.currentEnterprise.name || '新维创想科技有限公司', '新维创想科技有限公司', true)}
              ${renderOcrRow('法定代表人', '李明', '李敏', false)}
            </section>
            <div class="form-bottom-bar">
              <a class="btn ghost" href="/enterprise/applications" data-link>上一步</a>
              <span>系统已于 14:20:05 自动保存草稿</span>
              <a class="btn ghost" href="/enterprise/applications" data-link>保存草稿</a>
              <button class="btn primary" type="submit">提交申请</button>
            </div>
          </form>
        </div>
      </section>
    `);
    bindNewApplicationForm(context);
    bindNewApplicationPrototype();
  }

  function bindNewApplicationForm(context) {
    const form = document.querySelector('#new-application-form');
    form?.addEventListener('submit', async (event) => {
      event.preventDefault();
      hideAlert();
      const policyId = form.policyId.value;
      if (!policyId) {
        showAlert('请选择申报政策。');
        return;
      }
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      button.textContent = '正在创建';
      try {
        if (policyId.startsWith('demo-')) {
          navigate('/enterprise/applications/demo-application-88921');
          return;
        }
        const created = await apiFetch('/applications', {
          method: 'POST',
          body: JSON.stringify({
            enterprise_id: context.currentEnterprise.enterprise_id,
            policy_id: policyId,
          }),
        });
        navigate(`/enterprise/applications/${created.application_id}`);
      } catch (error) {
        showAlert(toFriendlyError(error));
      } finally {
        button.disabled = false;
        button.textContent = '提交申请';
      }
    });
  }

  async function renderEnterpriseApplicationDetail(user, context, applicationId) {
    if (context.approved.length === 0) {
      renderEnterpriseLocked(user, context, '申报详情', '申报详情需要绑定并审核通过企业主体后查看。');
      return;
    }
    const loaded = await apiFetch(`/applications/${applicationId}`).catch((error) => ({ error }));
    if (loaded.error && !applicationId.startsWith('demo-')) {
      renderEnterpriseUtility(user, context, '申报不存在', toFriendlyError(loaded.error));
      return;
    }
    const detail = loaded.error ? demoApplicationDetail(applicationId) : loaded;
    const activeStep = applicationStepIndex(detail.status);
    const materials = detail.materials || [];
    const policyTitle = detail.policy_title || detail.policy?.title || '2024 High-Tech Enterprise Grant';
    app.innerHTML = enterpriseLayout(user, context, `
      ${enterpriseHero(policyTitle, `Application ID: ${detail.application_id}`, `
        <a class="btn ghost" href="/enterprise/applications" data-link>Back to List</a>
        ${['submitted', 'pre_reviewing', 'reviewing', 'need_supplement', 'resubmitted', 'manual_review'].includes(detail.status) ? '<button class="btn ghost" id="withdraw-application">Withdraw</button>' : ''}
        ${detail.status === 'need_supplement' ? `<a class="btn primary" href="/enterprise/supplements/${detail.application_id}" data-link>Go to Supplement</a>` : ''}
      `, { kicker: 'Application Detail' })}

      <div class="enterprise-grid detail application-detail-grid">
        <section class="enterprise-card application-detail-main">
          ${stepper(['Draft', 'Submitted', 'Reviewing', 'Final Decision'], activeStep)}
          <div id="form-alert" class="alert"></div>
          ${detail.status === 'need_supplement' ? renderAuditOpinion(detail) : ''}

          <section class="detail-section">
            <div class="section-head"><h2>Basic Information</h2><b class="status-badge ${escapeHtml(detail.status)}">${statusText(detail.status)}</b></div>
            <div class="info-grid">
              <div><span>企业名称</span><strong>${escapeHtml(context.currentEnterprise.name || '创领科技有限公司')}</strong></div>
              <div><span>提交时间</span><strong>${escapeHtml(formatDate(detail.submitted_at || detail.created_at, '2024-09-18'))}</strong></div>
              <div><span>申报编号</span><strong>${escapeHtml(detail.application_id)}</strong></div>
              <div><span>当前阶段</span><strong>${statusText(detail.status)}</strong></div>
            </div>
          </section>

          <section class="detail-section">
            <div class="section-head"><h2>Submitted Materials</h2><a href="/enterprise/applications/${detail.application_id}" data-link>Download All (.zip)</a></div>
            <div class="material-list">
              ${materials.map(renderMaterialRow).join('') || '<p class="muted">暂无材料。草稿状态下可先上传营业执照、纳税证明等申报材料。</p>'}
            </div>
            ${detail.status === 'draft' ? renderMaterialUploadForm() : ''}
          </section>

          <div class="enterprise-actions">
            ${detail.status === 'draft' ? '<button class="btn primary" id="submit-application">提交申报</button>' : ''}
            <a class="btn ghost" href="/enterprise/applications" data-link>返回列表</a>
          </div>
        </section>

        <aside class="detail-side-panel">
          <section class="enterprise-card policy-side-card">
            <span class="card-kicker">Policy Info</span>
            <h2>${escapeHtml(policyTitle)}</h2>
            <p>Expected Grant Amount</p>
            <strong class="grant-amount">${moneyText(detail.expected_amount, '¥200,000')}</strong>
            <div class="overview-progress compact-progress">
              <div><strong>Completion Progress 75%</strong><span>材料与审核进度</span></div>
              ${progressBar(75, 'Completion Progress')}
            </div>
          </section>
          <section class="enterprise-card help-card">
            <span class="card-kicker">Need Help?</span>
            <h2>Online Consultation</h2>
            <p>政策专员可协助确认材料补正范围、截止时间和申报策略。</p>
            <a class="btn primary full" href="/enterprise/qa" data-link>Online Consultation</a>
          </section>
        </aside>
      </div>
    `);
    bindApplicationMaterialForm(context, detail);
    document.querySelector('#submit-application')?.addEventListener('click', async () => {
      try {
        if (applicationId.startsWith('demo-')) {
          navigate(`/enterprise/applications/${applicationId}`);
          return;
        }
        await apiFetch(`/applications/${applicationId}/submit`, { method: 'POST', body: '{}' });
        navigate(`/enterprise/applications/${applicationId}`);
      } catch (error) {
        showAlert(toFriendlyError(error));
      }
    });
    document.querySelector('#withdraw-application')?.addEventListener('click', async () => {
      try {
        if (applicationId.startsWith('demo-')) {
          navigate('/enterprise/applications');
          return;
        }
        await apiFetch(`/applications/${applicationId}/withdraw`, {
          method: 'POST',
          body: JSON.stringify({ comment: '企业端主动撤回' }),
        });
        navigate(`/enterprise/applications/${applicationId}`);
      } catch (error) {
        showAlert(toFriendlyError(error));
      }
    });
  }

  function bindApplicationMaterialForm(context, detail) {
    const form = document.querySelector('#application-material-form');
    form?.addEventListener('submit', async (event) => {
      event.preventDefault();
      hideAlert();
      const file = form.file.files[0];
      if (!file) {
        showAlert('请先选择需要上传的材料。');
        return;
      }
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      button.textContent = '上传中';
      try {
        if (detail.application_id.startsWith('demo-')) {
          navigate(`/enterprise/applications/${detail.application_id}`);
          return;
        }
        const upload = new FormData();
        upload.append('enterprise_id', context.currentEnterprise.enterprise_id);
        upload.append('purpose', 'enterprise_resource');
        upload.append('file', file);
        const uploaded = await apiUpload('/files', upload);
        await apiFetch('/materials', {
          method: 'POST',
          body: JSON.stringify({
            application_id: detail.application_id,
            material_type: form.materialType.value.trim(),
            file_id: uploaded.file_id,
            security_level: 'L2',
          }),
        });
        navigate(`/enterprise/applications/${detail.application_id}`);
      } catch (error) {
        showAlert(toFriendlyError(error));
      } finally {
        button.disabled = false;
        button.textContent = '上传到当前申报';
      }
    });
  }

  function bindApplicationFilters() {
    const search = document.querySelector('#application-search');
    const filters = [...document.querySelectorAll('.status-filter button')];
    const rows = [...document.querySelectorAll('.application-row')];
    const apply = () => {
      const keyword = (search?.value || '').trim().toLowerCase();
      const active = document.querySelector('.status-filter button.active')?.dataset.status || 'all';
      rows.forEach((row) => {
        const matchedStatus = active === 'all' || row.dataset.status === active;
        const matchedKeyword = !keyword || row.dataset.keywords.includes(keyword);
        row.hidden = !(matchedStatus && matchedKeyword);
      });
    };
    search?.addEventListener('input', apply);
    filters.forEach((button) => {
      button.addEventListener('click', () => {
        filters.forEach((item) => item.classList.remove('active'));
        button.classList.add('active');
        apply();
      });
    });
  }

  function bindNewApplicationPrototype() {
    document.querySelectorAll('.material-item').forEach((item) => {
      item.addEventListener('click', () => {
        document.querySelectorAll('.material-item').forEach((node) => node.classList.remove('active'));
        item.classList.add('active');
      });
    });
    const input = document.querySelector('#new-application-file');
    input?.addEventListener('change', () => {
      const zone = document.querySelector('.upload-dropzone strong');
      const file = input.files?.[0];
      if (zone && file) {
        zone.textContent = `已选择：${file.name}`;
      }
    });
  }

  function renderStatusFilter(status, label, active = false) {
    return `<button class="${active ? 'active' : ''}" type="button" data-status="${status}">${label}</button>`;
  }

  function renderOcrRow(label, systemValue, fileValue, matched) {
    return `
      <div class="ocr-row ${matched ? 'matched' : 'diff'}">
        <span>${label}</span>
        <strong>${escapeHtml(systemValue)}</strong>
        <em>${escapeHtml(fileValue)}</em>
        <button class="text-action" type="button">${matched ? '已确认' : '更正'}</button>
      </div>
    `;
  }

  function renderAuditOpinion(detail) {
    const reason = detail.supplement?.reason || '缺少 Q3 2023 研发费用文件官方盖章，请在截止日前重新上传补正材料。';
    return `
      <section class="audit-opinion-card">
        <div>
          <span class="card-kicker">Audit Opinion: Needs Supplement</span>
          <h2>需要补正材料</h2>
          <p>${escapeHtml(reason)}</p>
        </div>
        <b>Deadline: Oct 18, 2024</b>
      </section>
    `;
  }

  function renderMaterialRow(item) {
    return `
      <div class="material-row">
        <div><strong>${escapeHtml(item.original_filename || item.material_type || '申报材料')}</strong><span>${escapeHtml(item.material_type || 'supporting_document')}</span></div>
        <b class="status-badge ${escapeHtml(item.ocr_status || 'submitted')}">${escapeHtml(item.ocr_status || '已上传')}</b>
        <a href="/enterprise/applications" data-link>download</a>
      </div>
    `;
  }

  function renderMaterialUploadForm() {
    return `
      <form id="application-material-form" class="upload-inline-form">
        <div class="field"><label>材料类型</label><input name="materialType" value="business_license"></div>
        <div class="field"><label>上传材料</label><input name="file" type="file"></div>
        <button class="btn ghost" type="submit">上传到当前申报</button>
      </form>
    `;
  }

  function applicationStepIndex(status) {
    if (status === 'draft') return 0;
    if (['submitted', 'pre_reviewing'].includes(status)) return 1;
    if (['reviewing', 'manual_review', 'need_supplement', 'resubmitted'].includes(status)) return 2;
    return 3;
  }

  function demoPolicies() {
    return [
      { policy_id: 'demo-policy-digital', title: 'SME Digitalization Grant 2024' },
      { policy_id: 'demo-policy-green', title: 'Green Energy Tax Rebate' },
      { policy_id: 'demo-policy-rd', title: 'R&D Innovation Credit' },
    ];
  }

  function demoApplications() {
    return [
      { application_id: 'demo-application-88421', policy_title: 'SME Digitalization Grant 2024', status: 'need_supplement', created_at: '2024-10-12' },
      { application_id: 'demo-application-88418', policy_title: 'Green Energy Tax Rebate', status: 'reviewing', created_at: '2024-09-26' },
      { application_id: 'demo-application-88405', policy_title: 'Talent Retention Subsidy', status: 'submitted', created_at: '2024-09-18' },
      { application_id: 'demo-application-88392', policy_title: 'R&D Innovation Credit', status: 'draft', created_at: '2024-09-06' },
      { application_id: 'demo-application-88320', policy_title: 'Export Expansion Support', status: 'approved', created_at: '2024-08-20' },
    ];
  }

  function demoApplicationDetail(applicationId) {
    return {
      application_id: applicationId,
      policy_title: '2024 High-Tech Enterprise Grant',
      status: applicationId.includes('88392') ? 'draft' : 'need_supplement',
      created_at: '2024-09-18',
      submitted_at: '2024-09-20',
      expected_amount: 200000,
      supplement: {
        reason: '缺少 Q3 2023 研发费用文件官方盖章，请在 5 个工作日内重新上传。',
      },
      policy_items: [{ item_id: 'demo-item-1', policy_id: 'HTE-2024', status: 'need_supplement' }],
      materials: [
        { original_filename: 'Business_License.pdf', material_type: 'business_license', ocr_status: 'verified' },
        { original_filename: 'R&D_Expense_Q1_Q2.pdf', material_type: 'rd_expense', ocr_status: 'verified' },
      ],
    };
  }

  return {
    renderEnterpriseApplicationDetail,
    renderEnterpriseApplicationNew,
    renderEnterpriseApplications,
  };
}
