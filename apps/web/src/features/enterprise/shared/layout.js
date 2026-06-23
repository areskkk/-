export function createEnterpriseLayout({ escapeHtml, shell }) {
  const navItems = [
    { path: '/enterprise/dashboard', label: '工作台', icon: '⌘' },
    { path: '/enterprise/qa', label: '政策问答', icon: '✦' },
    { path: '/enterprise/profile', label: '企业画像', icon: '◌' },
    { path: '/enterprise/policies', label: '政策推荐', icon: '▣' },
    { path: '/enterprise/applications', label: '我的申报', icon: '▤' },
    { path: '/enterprise/bind', label: '企业绑定', icon: '◎' },
  ];

  function enterpriseNavItem(item) {
    const active = location.pathname === item.path || (
      item.path !== '/enterprise/dashboard' && location.pathname.startsWith(item.path)
    );
    return `<a class="enterprise-nav-item${active ? ' active' : ''}" href="${item.path}" data-link><i>${item.icon}</i><span>${item.label}</span></a>`;
  }

  function enterpriseLayout(user, context, content) {
    const enterpriseName = context.currentEnterprise?.name || '未绑定企业';
    const initials = (user.name || '企业用户').slice(0, 1).toUpperCase();
    return shell(`
      <div class="enterprise-app">
        <aside class="enterprise-sidebar">
          <div>
            <a class="enterprise-brand" href="/enterprise/dashboard" data-link aria-label="返回企业工作台">
              <span>CivicPortal</span>
              <strong>Enterprise Console</strong>
            </a>
            <nav class="enterprise-nav" aria-label="企业端导航">
              ${navItems.map(enterpriseNavItem).join('')}
            </nav>
          </div>
          <div class="enterprise-sidebar-foot">
            <span>当前账号</span>
            <strong>${escapeHtml(user.name || '企业用户')}</strong>
            <small>${escapeHtml(enterpriseName)}</small>
            <a href="/logout" data-link>退出登录</a>
          </div>
        </aside>
        <main class="enterprise-main">
          <header class="enterprise-top">
            <div>
              <span class="enterprise-kicker">CivicPortal Enterprise</span>
              <strong>${escapeHtml(enterpriseName)}</strong>
            </div>
            <nav class="enterprise-top-links" aria-label="企业端顶部导航">
              <a href="/enterprise/dashboard" data-link>Dashboard</a>
              <a href="/enterprise/qa" data-link>Enterprise Services</a>
              <a href="/enterprise/applications" data-link>Applications</a>
              <a href="/enterprise/qa" data-link>Support</a>
            </nav>
            <div class="enterprise-top-actions">
              <a class="btn ghost" href="/enterprise/notifications" data-link>消息</a>
              <a class="btn primary" href="/enterprise/applications/new" data-link>新建申报</a>
              <a class="enterprise-avatar" href="/profile" data-link aria-label="账号信息">${escapeHtml(initials)}</a>
            </div>
          </header>
          ${content}
        </main>
      </div>
    `, { hideFooter: true, hideTopbar: true, fullPage: true, user });
  }

  function enterpriseHero(title, subtitle, action = '', options = {}) {
    return `
      <section class="enterprise-hero${options.compact ? ' compact' : ''}">
        <div>
          ${options.breadcrumb ? `<div class="enterprise-breadcrumb">${options.breadcrumb}</div>` : ''}
          <span class="enterprise-kicker">${escapeHtml(options.kicker || '企业服务')}</span>
          <h1>${escapeHtml(title)}</h1>
          <p>${escapeHtml(subtitle)}</p>
        </div>
        ${action ? `<div class="enterprise-hero-actions">${action}</div>` : ''}
      </section>
    `;
  }

  return { enterpriseHero, enterpriseLayout };
}
