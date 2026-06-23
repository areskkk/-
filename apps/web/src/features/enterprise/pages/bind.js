import { bindingStatusLabels, statusText } from '../shared/status.js';

export function createEnterpriseBindPage(deps) {
  const {
    apiFetch,
    apiUpload,
    escapeHtml,
    replace,
    shell,
    showAlert,
    hideAlert,
    toFriendlyError,
  } = deps;

  function renderEnterpriseBind(user, context) {
    const bindings = context.enterprises || [];
    const latestBinding = bindings[0] || null;
    const bindingStatus = latestBinding?.auth_status || null;
    const isReviewing = bindingStatus === 'pending';
    const isApproved = bindingStatus === 'agent_approved' || bindingStatus === 'manual_approved';
    const pending = JSON.parse(localStorage.getItem('zjb_pending_enterprise') || '{}');
    deps.app.innerHTML = shell(`
      <main class="enterprise-bind-page">
        <section class="bind-header">
          <h1>企业身份绑定</h1>
          <p>完成企业认证，开启 CivicPortal Enterprise 高级管理功能</p>
        </section>

        <nav class="bind-steps" aria-label="企业绑定进度">
          <div class="bind-step${!isReviewing && !isApproved ? ' active' : ' done'}"><b>1</b><span>企业信息</span></div>
          <i></i>
          <div class="bind-step${isReviewing ? ' active' : isApproved ? ' done' : ''}"><b>2</b><span>审核验证</span></div>
          <i></i>
          <div class="bind-step${isApproved ? ' active' : ''}"><b>3</b><span>绑定完成</span></div>
        </nav>

        ${isReviewing
          ? renderBindReviewCard(latestBinding)
          : isApproved
            ? renderBindApprovedCard(latestBinding)
            : renderBindFormCard(bindings, pending)}

        <section class="bind-helper-grid" aria-label="企业绑定说明">
          <article>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"></path><path d="m9 12 2 2 4-4"></path></svg>
            <h2>安全可靠</h2>
            <p>采用加密存储与权限校验保护企业资质数据</p>
          </article>
          <article>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 14l4-4"></path><path d="M3.34 19a10 10 0 1 1 17.32 0"></path></svg>
            <h2>极速处理</h2>
            <p>AI 初审辅助人工复核，减少重复等待</p>
          </article>
          <article>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 10a6 6 0 0 0-12 0v4"></path><path d="M4 14h4v5H4z"></path><path d="M16 14h4v5h-4z"></path><path d="M12 19v2"></path></svg>
            <h2>专属支持</h2>
            <p>如认证受阻，可联系平台管理员协助处理</p>
          </article>
        </section>
      </main>
    `, { user });
    if (!isReviewing && !isApproved) {
      bindEnterpriseBindForm();
      bindEnterpriseBindUploadPreview();
    }
  }

  function renderBindFormCard(bindings, pending) {
    return `
      <section class="bind-card">
        ${bindings.length ? renderBindingStatusNotice(bindings) : ''}
        <div id="form-alert" class="alert"></div>
        <form id="enterprise-bind-form" class="bind-form">
          <div class="field bind-field">
            <label>企业全称</label>
            <input name="enterpriseName" value="${escapeHtml(pending.enterprise_name || '')}" placeholder="请输入工商登记的企业完整名称">
            <span class="hint">请确保与营业执照上的名称完全一致</span>
          </div>
          <div class="field bind-field">
            <label>统一社会信用代码</label>
            <input name="creditCode" maxlength="18" value="${escapeHtml(pending.credit_code || '')}" placeholder="18位统一社会信用代码">
          </div>
          <div class="bind-upload-field">
            <label>营业执照扫描件</label>
            <label class="bind-upload-zone" for="bind-license">
              <input id="bind-license" name="license" type="file" accept=".jpg,.jpeg,.png,.pdf">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 16V8"></path>
                <path d="m8 12 4-4 4 4"></path>
                <path d="M20 16.5A4.5 4.5 0 0 0 15.5 12h-.7A6 6 0 1 0 6 17.3"></path>
                <path d="M6 17.3h12"></path>
              </svg>
              <strong>点击或将文件拖拽至此上传</strong>
              <span>支持 JPG、PNG、PDF 格式（最大 10MB）</span>
            </label>
            <div class="bind-file-preview" id="bind-file-preview" hidden>
              <div>
                <strong id="bind-file-name">营业执照文件</strong>
                <span>已就绪，提交后进入审核验证</span>
              </div>
              <button type="button" id="bind-file-remove" aria-label="移除文件">×</button>
            </div>
          </div>
          <label class="bind-agreement">
            <input type="checkbox" name="agreement">
            <span>我代表企业确认，上述信息准确无误，并同意遵守企业服务条款及数据隐私声明。</span>
          </label>
          <button class="btn primary full bind-submit" type="submit">提交绑定申请</button>
          <p class="bind-review-time">预计审核时间：1-2 个工作日</p>
        </form>
      </section>
    `;
  }

  function renderBindReviewCard(binding) {
    return `
      <section class="bind-card bind-review-card">
        ${renderBindingStatusNotice([binding])}
        <div class="bind-review-body">
          <div class="bind-review-icon">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 8v5l3 2"></path>
              <path d="M21 12a9 9 0 1 1-9-9"></path>
              <path d="M16 3h5v5"></path>
            </svg>
          </div>
          <h2>审核验证中</h2>
          <p>你的企业绑定申请已提交，系统正在进行 OCR 初审和人工复核。审核期间无需重复提交资料。</p>
          <div class="bind-review-list">
            <div><span>当前状态</span><strong>待审核</strong></div>
            <div><span>预计时间</span><strong>1-2 个工作日</strong></div>
            <div><span>后续操作</span><strong>审核通过后自动进入企业端</strong></div>
          </div>
          <a class="btn ghost" href="/profile" data-link>查看账号信息</a>
        </div>
      </section>
    `;
  }

  function renderBindApprovedCard(binding) {
    return `
      <section class="bind-card bind-review-card">
        ${renderBindingStatusNotice([binding])}
        <div class="bind-review-body">
          <div class="bind-review-icon success">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M20 6 9 17l-5-5"></path>
            </svg>
          </div>
          <h2>绑定已完成</h2>
          <p>企业身份已通过验证，可以进入企业端维护画像、咨询政策并发起申报。</p>
          <a class="btn primary" href="/enterprise/dashboard" data-link>进入企业工作台</a>
        </div>
      </section>
    `;
  }

  function renderBindingStatusNotice(bindings) {
    const latest = bindings[0] || {};
    const enterpriseName = latest.name || latest.enterprise_name || '企业名称待确认';
    const creditCode = latest.credit_code || latest.creditCode || '信用代码待确认';
    return `
      <div class="bind-status-notice">
        <div>
          <span>当前绑定状态</span>
          <strong>${escapeHtml(enterpriseName)}</strong>
          <p>${escapeHtml(creditCode)}</p>
        </div>
        <b class="status-badge ${latest.auth_status || 'pending'}">${statusText(latest.auth_status, bindingStatusLabels)}</b>
      </div>
    `;
  }

  function bindEnterpriseBindUploadPreview() {
    const input = document.querySelector('#bind-license');
    const preview = document.querySelector('#bind-file-preview');
    const fileName = document.querySelector('#bind-file-name');
    const remove = document.querySelector('#bind-file-remove');
    input?.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) {
        return;
      }
      fileName.textContent = file.name;
      preview.hidden = false;
    });
    remove?.addEventListener('click', () => {
      input.value = '';
      preview.hidden = true;
      fileName.textContent = '营业执照文件';
    });
  }

  function bindEnterpriseBindForm() {
    const form = document.querySelector('#enterprise-bind-form');
    form?.addEventListener('submit', async (event) => {
      event.preventDefault();
      hideAlert();
      const enterpriseName = form.enterpriseName.value.trim();
      const creditCode = form.creditCode.value.trim().toUpperCase();
      const file = form.license.files[0];
      if (!enterpriseName || !/^[0-9A-Z]{18}$/.test(creditCode)) {
        showAlert('请输入企业名称和 18 位统一社会信用代码。');
        return;
      }
      if (!file) {
        showAlert('请上传营业执照。');
        return;
      }
      if (!form.agreement.checked) {
        showAlert('请先确认企业信息真实准确并同意服务条款。');
        return;
      }
      if (file.size > 10 * 1024 * 1024) {
        showAlert('营业执照文件不能超过 10MB。');
        return;
      }
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      button.textContent = '正在处理';
      try {
        const upload = new FormData();
        upload.append('purpose', 'enterprise_binding');
        upload.append('file', file);
        const uploaded = await apiUpload('/files', upload);
        const result = await apiFetch('/enterprises/bind', {
          method: 'POST',
          body: JSON.stringify({
            enterprise_name: enterpriseName,
            credit_code: creditCode,
            license_file_id: uploaded.file_id,
          }),
        });
        localStorage.removeItem('zjb_pending_enterprise');
        replace(
          result.status === 'agent_approved' || result.status === 'manual_approved'
            ? '/enterprise/dashboard'
            : '/enterprise/bind',
        );
      } catch (error) {
        showAlert(toFriendlyError(error));
      } finally {
        button.disabled = false;
        button.textContent = '提交绑定申请';
      }
    });
  }

  return { renderEnterpriseBind };
}
