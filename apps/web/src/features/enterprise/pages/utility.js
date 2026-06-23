export function createEnterpriseUtilityPage({ app, enterpriseHero, enterpriseLayout }) {
  function renderEnterpriseUtility(user, context, title, text) {
    app.innerHTML = enterpriseLayout(user, context, `
      ${enterpriseHero(title, text)}
      <section class="enterprise-card empty-state">
        <h2>${title}</h2>
        <p>${text}</p>
        <a class="btn primary" href="/enterprise/dashboard" data-link>返回工作台</a>
      </section>
    `);
  }

  function renderEnterpriseLocked(user, context, title, text) {
    const latestBinding = context.enterprises?.[0] || null;
    const isPending = latestBinding?.auth_status === 'pending';
    app.innerHTML = enterpriseLayout(user, context, `
      ${enterpriseHero(title, text, '<a class="btn primary" href="/enterprise/bind" data-link>企业身份绑定</a>')}
      <section class="enterprise-card empty-state">
        <h2>${isPending ? '企业绑定审核中' : '需要先完成企业绑定'}</h2>
        <p>${isPending ? '当前功能将在企业绑定审核通过后启用，审核期间可以查看工作台、政策问答、政策推荐和账号设置。' : text}</p>
        <div class="enterprise-actions">
          <a class="btn primary" href="/enterprise/bind" data-link>${isPending ? '查看审核状态' : '去绑定企业'}</a>
          <a class="btn ghost" href="/enterprise/dashboard" data-link>返回工作台</a>
        </div>
      </section>
    `);
  }

  return { renderEnterpriseLocked, renderEnterpriseUtility };
}
