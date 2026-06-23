export function createEnterpriseSupplementsPage({
  app,
  apiFetch,
  apiUpload,
  enterpriseHero,
  enterpriseLayout,
  escapeHtml,
  hideAlert,
  navigate,
  renderEnterpriseLocked,
  renderEnterpriseUtility,
  showAlert,
  toFriendlyError,
}) {
  async function renderEnterpriseSupplement(user, context, applicationId) {
    if (context.approved.length === 0) {
      renderEnterpriseLocked(user, context, '补正处理', '补正处理需要绑定并审核通过企业主体后使用。');
      return;
    }
    const loaded = await apiFetch(`/applications/${applicationId}`).catch((error) => ({ error }));
    if (loaded.error && !applicationId.startsWith('demo-')) {
      renderEnterpriseUtility(user, context, '补正记录不存在', toFriendlyError(loaded.error));
      return;
    }
    const detail = loaded.error ? demoSupplementDetail(applicationId) : loaded;
    const supplement = detail.supplement || {};
    const reason = supplement.reason || '缺少 Business Sustainability Report 2023 财年官方盖章；Certificate of Operation 图片过于模糊，请在 5 个工作日内重新上传。';
    app.innerHTML = enterpriseLayout(user, context, `
      ${enterpriseHero('补正处理', `Supplement Processing for Application #${detail.application_id}`, `
        <a class="btn ghost" href="/enterprise/applications/${detail.application_id}" data-link>返回详情</a>
        <a class="btn primary" href="/enterprise/applications" data-link>Applications</a>
      `, {
        kicker: 'Action Required',
        breadcrumb: `<a href="/enterprise/applications" data-link>Applications</a><span>/</span><a href="/enterprise/applications/${detail.application_id}" data-link>Case #${escapeHtml(detail.application_id)}</a><span>/</span><b>Supplement Processing</b>`,
      })}

      <div class="supplement-layout">
        <main class="supplement-main">
          <section class="supplement-alert-card">
            <div>
              <span class="card-kicker">Audit Feedback（审核反馈）</span>
              <h2>请按审核意见完成补正</h2>
              <p>${escapeHtml(reason)}</p>
            </div>
            <b>5 个工作日内</b>
          </section>

          <section class="enterprise-card supplement-items-card">
            <div class="section-head"><h2>Missing or Incorrect Items</h2><span>待补正材料</span></div>
            <div class="supplement-item-grid">
              ${renderSupplementItem('Business Sustainability Report', 'Missing Seal', '请上传带企业公章的 2023 财年可持续经营报告。')}
              ${renderSupplementItem('Certificate of Operation', 'Low Resolution', '请上传清晰扫描件，确保证书编号与企业名称可识别。')}
            </div>
          </section>

          <section class="enterprise-card original-preview-card">
            <div class="section-head"><h2>Original Application Preview</h2><a href="/enterprise/applications/${detail.application_id}" data-link>查看完整申报</a></div>
            <div class="info-grid">
              <div><span>Application ID</span><strong>${escapeHtml(detail.application_id)}</strong></div>
              <div><span>Policy Name</span><strong>${escapeHtml(detail.policy_title || '2024 High-Tech Enterprise Grant')}</strong></div>
              <div><span>Current Status</span><strong>Needs Supplement</strong></div>
              <div><span>Applicant</span><strong>${escapeHtml(context.currentEnterprise.name || '创领科技有限公司')}</strong></div>
            </div>
          </section>
        </main>

        <aside class="enterprise-card supplement-submit-card">
          <span class="card-kicker">Supplement Remarks</span>
          <h2>Process Update</h2>
          <div id="form-alert" class="alert"></div>
          <form id="supplement-form" class="form supplement-form">
            <label class="upload-dropzone" for="supplement-file">
              <input id="supplement-file" name="file" type="file" accept=".jpg,.jpeg,.png,.pdf">
              <span class="upload-icon">↑</span>
              <strong>上传补正材料</strong>
              <em>支持 PDF / JPG / PNG</em>
            </label>
            <div class="field"><label>材料类型</label><input name="materialType" value="business_sustainability_report"></div>
            <div class="field"><label>Notes to Auditor</label><input name="comment" placeholder="请输入补正说明，例如：已补充盖章版材料"></div>
            <button class="btn primary full" type="submit">Submit Supplement</button>
            <a class="btn ghost full" href="/enterprise/applications/${detail.application_id}" data-link>Save Progress</a>
          </form>
        </aside>
      </div>

      <div id="supplement-success-modal" class="enterprise-modal" hidden>
        <div class="enterprise-modal-card">
          <strong>Supplement Submitted</strong>
          <p>Your corrections have been successfully uploaded and sent for re-audit.</p>
          <a class="btn primary" href="/enterprise/dashboard" data-link>Return to Dashboard</a>
          <a class="btn ghost" href="/enterprise/applications/${detail.application_id}" data-link>查看申报详情</a>
        </div>
      </div>
    `);
    bindSupplementForm(context, detail);
    bindSupplementUploadPreview();
  }

  function renderSupplementItem(title, badge, text) {
    return `
      <article class="supplement-item">
        <div><strong>${title}</strong><span>${text}</span></div>
        <b>${badge}</b>
      </article>
    `;
  }

  function bindSupplementUploadPreview() {
    const input = document.querySelector('#supplement-file');
    input?.addEventListener('change', () => {
      const name = input.files?.[0]?.name;
      const label = document.querySelector('.supplement-submit-card .upload-dropzone strong');
      if (name && label) {
        label.textContent = `已选择：${name}`;
      }
    });
  }

  function bindSupplementForm(context, detail) {
    const form = document.querySelector('#supplement-form');
    form?.addEventListener('submit', async (event) => {
      event.preventDefault();
      hideAlert();
      const file = form.file.files[0];
      if (!file) {
        showAlert('请上传补正材料。');
        return;
      }
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      button.textContent = 'Submitting...';
      try {
        if (detail.application_id.startsWith('demo-')) {
          const modal = document.querySelector('#supplement-success-modal');
          if (modal) {
            modal.hidden = false;
          }
          return;
        }
        const upload = new FormData();
        upload.append('enterprise_id', context.currentEnterprise.enterprise_id);
        upload.append('purpose', 'enterprise_resource');
        upload.append('file', file);
        const uploaded = await apiUpload('/files', upload);
        await apiFetch(`/applications/${detail.application_id}/supplements`, {
          method: 'POST',
          body: JSON.stringify({
            item_id: detail.policy_items?.[0]?.item_id,
            comment: form.comment.value.trim(),
            materials: [{
              material_type: form.materialType.value.trim(),
              file_id: uploaded.file_id,
              mode: 'append',
              security_level: 'L2',
            }],
          }),
        });
        const modal = document.querySelector('#supplement-success-modal');
        if (modal) {
          modal.hidden = false;
        } else {
          navigate(`/enterprise/applications/${detail.application_id}`);
        }
      } catch (error) {
        showAlert(toFriendlyError(error));
      } finally {
        button.disabled = false;
        button.textContent = 'Submit Supplement';
      }
    });
  }

  function demoSupplementDetail(applicationId) {
    return {
      application_id: applicationId,
      policy_title: '2024 High-Tech Enterprise Grant',
      status: 'need_supplement',
      policy_items: [{ item_id: 'demo-item-1' }],
      supplement: {
        reason: '缺少 Business Sustainability Report 2023 财年官方盖章；Certificate of Operation 图片过于模糊，请在 5 个工作日内重新上传。',
      },
    };
  }

  return { renderEnterpriseSupplement };
}
