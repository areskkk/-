import { statusText } from '../shared/status.js';

export function createEnterpriseDashboardPage({
  app,
  apiFetch,
  applicationRow,
  emptyBlock,
  enterpriseHero,
  enterpriseLayout,
  formatDate,
  metricCard,
  policyCard,
  profileCompleteness,
  progressBar,
}) {
  async function renderEnterpriseDashboard(user, context) {
    if (!context.currentEnterprise || context.approved.length === 0) {
      renderUnboundDashboard(user, context);
      return;
    }
    const [policies, applications] = await Promise.all([
      apiFetch('/policies?page_size=3').catch(() => ({ items: [] })),
      apiFetch(`/applications?enterprise_id=${context.currentEnterprise.enterprise_id}&page_size=5`).catch(() => ({ items: [] })),
    ]);
    const enterpriseName = context.currentEnterprise.name || '创领科技有限公司';
    const creditCode = context.currentEnterprise.credit_code || '91440300MA5EXXXX7Y';
    const policyItems = (policies.items || []).length ? policies.items : demoPolicies();
    const applicationItems = (applications.items || []).length ? applications.items : demoApplications();
    const profileRate = profileCompleteness(context.profile) || 85;
    const needSupplement = applicationItems.filter((item) => item.status === 'need_supplement');
    const primaryTodo = needSupplement[0] || applicationItems[0];
    app.innerHTML = enterpriseLayout(user, context, `
      ${enterpriseHero(`欢迎回来，${enterpriseName}`, '集中查看企业画像、政策推荐、申报进度和待办事项。', `
        <a class="btn ghost" href="/enterprise/applications" data-link>我的申报</a>
        <a class="btn primary" href="/enterprise/qa" data-link>政策咨询</a>
      `, { kicker: 'Dashboard' })}

      <section class="dashboard-bento">
        <article class="enterprise-card overview-card bento-wide">
          <div class="section-head">
            <div>
              <span class="card-kicker">企业概览</span>
              <h2>${escapeDashboard(enterpriseName)}</h2>
            </div>
            <b class="status-badge approved">信用评级 A+</b>
          </div>
          <p class="detail-copy">统一社会信用代码：${escapeDashboard(creditCode)}</p>
          <div class="overview-progress">
            <div><strong>画像完整度 ${profileRate}%</strong><span>影响政策匹配、资格预判和材料预填</span></div>
            ${progressBar(profileRate, '画像完整度')}
          </div>
          <div class="mini-stat-grid">
            <div><span>活跃申报</span><strong>${applicationItems.length}</strong></div>
            <div><span>获得奖励金</span><strong>¥450k</strong></div>
            <div><span>政策匹配</span><strong>${policyItems.length}</strong></div>
          </div>
        </article>

        <article class="enterprise-card profile-reminder-card">
          <span class="card-kicker">画像完善提醒</span>
          <h2>补齐关键财务数据</h2>
          <p>您的画像还缺少研发投入、纳税额等关键经营数据，完善后可提升政策推荐准确率。</p>
          <a class="btn primary" href="/enterprise/profile" data-link>立即完善</a>
        </article>

        <article class="enterprise-card todo-card">
          <div class="section-head"><h2>待办事项</h2><a href="/enterprise/applications" data-link>查看全部</a></div>
          <div class="todo-list">
            ${renderTodo('高新企业认定申请', '草稿待提交 · 建议今天完成材料上传', '/enterprise/applications/new', '继续填写')}
            ${primaryTodo ? renderTodo(
              '研发补贴材料补正',
              `${statusText(primaryTodo.status)} · ${formatDate(primaryTodo.created_at, '2024-10-18')} 前处理`,
              `/enterprise/supplements/${primaryTodo.application_id || 'demo-application-88921'}`,
              '处理补正',
              'warning',
            ) : ''}
            ${renderTodo('发票 OCR 自动识别确认', '系统发现 2 处字段差异', '/enterprise/applications/new', '去确认')}
          </div>
        </article>

        <section class="enterprise-card bento-wide recommendation-panel">
          <div class="section-head"><h2>智能推荐政策</h2><a href="/enterprise/qa" data-link>咨询政策助手</a></div>
          ${policyItems.map(policyCard).join('') || emptyBlock('暂无推荐政策', '请先维护企业画像或稍后再试。')}
        </section>

        <section class="enterprise-card progress-panel">
          <div class="section-head"><h2>当前申报进度</h2><a href="/enterprise/applications" data-link>进入列表</a></div>
          <div class="progress-timeline">
            <div class="done"><b>1</b><span>Draft</span><small>草稿已创建</small></div>
            <div class="done"><b>2</b><span>Submitted</span><small>材料已提交</small></div>
            <div class="active"><b>3</b><span>Reviewing</span><small>审核中</small></div>
            <div><b>4</b><span>Final Decision</span><small>等待决定</small></div>
          </div>
          ${(applicationItems || []).slice(0, 3).map(applicationRow).join('')}
        </section>
      </section>
    `);
  }

  function renderUnboundDashboard(user, context) {
    const latestBinding = context.enterprises?.[0] || null;
    const isPending = latestBinding?.auth_status === 'pending';
    const statusTitle = isPending ? '企业绑定审核中' : '企业主体尚未绑定';
    const statusTextContent = isPending
      ? '你的企业绑定申请已提交，审核通过后可使用政策匹配、申报办理和材料管理功能。'
      : '当前账号可以进入企业工作台，但需要先完成企业身份绑定后才能发起申报和维护企业画像。';
    app.innerHTML = enterpriseLayout(user, context, `
      ${enterpriseHero('企业工作台', '查看企业端服务入口、绑定状态和后续办理进度。', '<a class="btn primary" href="/enterprise/bind" data-link>企业身份绑定</a>', { kicker: 'Dashboard' })}
      <section class="enterprise-metrics">
        ${metricCard('绑定状态', isPending ? '待审核' : '未绑定', '企业主体认证状态', { icon: '◎' })}
        ${metricCard('画像完整度', '0%', '绑定通过后可维护', { icon: '◌' })}
        ${metricCard('申报总数', '0', '绑定通过后可创建', { icon: '▤' })}
        ${metricCard('推荐政策', '待开启', '完成绑定后匹配', { icon: '✦' })}
      </section>
      <div class="enterprise-grid two">
        <section class="enterprise-card">
          <div class="section-head"><h2>${statusTitle}</h2><a href="/enterprise/bind" data-link>查看绑定页</a></div>
          <p class="detail-copy">${statusTextContent}</p>
          <div class="enterprise-actions">
            <a class="btn primary" href="/enterprise/bind" data-link>${isPending ? '查看审核状态' : '开始绑定企业'}</a>
            <a class="btn ghost" href="/profile" data-link>查看账号信息</a>
          </div>
        </section>
        <section class="enterprise-card service-preview-card">
          <div class="section-head"><h2>可用服务预览</h2><span>绑定前预览</span></div>
          <div class="service-grid">
            <a href="/enterprise/qa" data-link><strong>政策问答</strong><span>咨询政策适配与材料要求</span></a>
            <a href="/enterprise/profile" data-link><strong>企业画像</strong><span>绑定通过后维护经营数据</span></a>
            <a href="/enterprise/applications" data-link><strong>我的申报</strong><span>绑定通过后查看办理进度</span></a>
          </div>
        </section>
      </div>
    `);
  }

  function renderTodo(title, meta, href, action, tone = '') {
    return `
      <a class="todo-item ${tone}" href="${href}" data-link>
        <div><strong>${title}</strong><span>${meta}</span></div>
        <b>${action}</b>
      </a>
    `;
  }

  function demoPolicies() {
    return [
      {
        policy_id: 'demo-policy-rd',
        title: '2024年度北京市研发费用加计扣除与专项奖励',
        source_name: '北京市经济和信息化局',
        summary: '面向软件与科技型企业，围绕研发费用、知识产权、创新平台建设提供资金补贴和税收优惠。',
      },
      {
        policy_id: 'demo-policy-digital',
        title: '中小企业数字化转型试点补助',
        source_name: '工业和信息化部',
        summary: '支持企业上线数字化系统、智能生产线和数据治理工具，最高可获得阶段性补助。',
      },
    ];
  }

  function demoApplications() {
    return [
      {
        application_id: 'demo-application-88921',
        status: 'need_supplement',
        policy_title: '2024 High-Tech Enterprise Grant',
        created_at: '2024-10-12',
      },
      {
        application_id: 'demo-application-88201',
        status: 'reviewing',
        policy_title: 'SME Digitalization Grant 2024',
        created_at: '2024-09-18',
      },
    ];
  }

  function escapeDashboard(value) {
    return String(value || '').replace(/[&<>'"]/g, (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;',
    }[char]));
  }

  return { renderEnterpriseDashboard };
}
