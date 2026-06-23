import { statusText } from './status.js';

export function createEnterpriseUi({ escapeHtml }) {
  function profileCompleteness(profile) {
    if (!profile) {
      return 0;
    }
    const fields = [
      'enterprise_name',
      'credit_code',
      'industry',
      'scale',
      'revenue_amount',
      'employee_count',
      'tax_amount',
      'tech_upgrade_status',
    ];
    const filled = fields.filter((field) => (
      profile[field] !== null && profile[field] !== undefined && profile[field] !== ''
    )).length;
    return Math.round((filled / fields.length) * 100);
  }

  function metricCard(label, value, text, options = {}) {
    const tone = options.tone ? ` ${options.tone}` : '';
    const icon = options.icon ? `<span class="metric-icon">${escapeHtml(options.icon)}</span>` : '';
    return `
      <article class="enterprise-metric${tone}">
        <div class="metric-top"><span>${escapeHtml(label)}</span>${icon}</div>
        <strong>${escapeHtml(value)}</strong>
        <p>${escapeHtml(text)}</p>
      </article>
    `;
  }

  function summaryText(value, maxLength = 120) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
  }

  function formatDate(value, fallback = '2024-09-18') {
    if (!value) {
      return fallback;
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return String(value).slice(0, 10);
    }
    return date.toISOString().slice(0, 10);
  }

  function moneyText(value, fallback = '¥200,000') {
    if (value === null || value === undefined || value === '') {
      return fallback;
    }
    const number = Number(value);
    if (Number.isNaN(number)) {
      return String(value);
    }
    return `¥${number.toLocaleString('zh-CN')}`;
  }

  function progressBar(percent, label = '') {
    const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
    return `
      <div class="progress-line" aria-label="${escapeHtml(label || `进度 ${safePercent}%`)}">
        <span style="width: ${safePercent}%"></span>
      </div>
    `;
  }

  function policyCard(policy) {
    const policyId = policy.policy_id || policy.id || 'demo-policy-rd';
    return `
      <article class="policy-card">
        <div>
          <span class="card-kicker">${escapeHtml(policy.source_name || policy.region || 'CivicPortal 精准匹配')}</span>
          <strong>${escapeHtml(policy.title || '2024年度北京市研发费用加计扣除与专项奖励')}</strong>
          <p>${escapeHtml(summaryText(policy.summary || policy.content || '面向研发投入持续增长的软件与科技企业，提供资金补贴、税收优惠和申报辅导。', 120))}</p>
        </div>
        <div class="policy-actions">
          <a class="btn ghost" href="/enterprise/policies/${policyId}" data-link>查看详情</a>
          <a class="btn primary" href="/enterprise/applications/new?policy_id=${policyId}" data-link>开始申报</a>
        </div>
      </article>
    `;
  }

  function applicationRow(item, options = {}) {
    const applicationId = item.application_id || item.id || 'demo-application-88921';
    const policyName = item.policy_title || item.policy_name || item.title || '2024 High-Tech Enterprise Grant';
    const submittedAt = formatDate(item.submitted_at || item.created_at, options.fallbackDate || '2024-09-18');
    const status = item.status || 'need_supplement';
    const showSupplement = status === 'need_supplement';
    return `
      <article class="enterprise-list-row application-row" data-status="${escapeHtml(status)}" data-keywords="${escapeHtml(`${applicationId} ${policyName}`.toLowerCase())}">
        <a class="row-id-cell" href="/enterprise/applications/${applicationId}" data-link>${escapeHtml(applicationId)}</a>
        <a class="row-main" href="/enterprise/applications/${applicationId}" data-link>
          <strong>${escapeHtml(policyName)}</strong>
          <small>${escapeHtml(item.description || item.caption || '企业政策申报记录')}</small>
        </a>
        <b class="status-badge ${escapeHtml(status)}">${statusText(status)}</b>
        <span>${escapeHtml(submittedAt)}</span>
        <div class="row-actions">
          ${showSupplement ? `<a class="btn mini primary" href="/enterprise/supplements/${applicationId}" data-link>Resolve</a>` : ''}
          <a class="btn mini ghost" href="/enterprise/applications/${applicationId}" data-link>查看详情</a>
        </div>
      </article>
    `;
  }

  function emptyBlock(title, text, action = '') {
    return `<div class="empty-state compact"><strong>${escapeHtml(title)}</strong><p>${escapeHtml(text)}</p>${action}</div>`;
  }

  function stepper(steps, activeIndex) {
    return `
      <ol class="enterprise-stepper">
        ${steps.map((step, index) => {
          const state = index < activeIndex ? ' done' : index === activeIndex ? ' active' : '';
          return `<li class="step${state}"><b>${index + 1}</b><span>${escapeHtml(step)}</span></li>`;
        }).join('')}
      </ol>
    `;
  }

  return {
    applicationRow,
    emptyBlock,
    formatDate,
    metricCard,
    moneyText,
    policyCard,
    profileCompleteness,
    progressBar,
    stepper,
    summaryText,
  };
}
