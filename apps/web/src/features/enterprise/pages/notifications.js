export function createEnterpriseNotificationsPage({
  app,
  emptyBlock,
  enterpriseHero,
  enterpriseLayout,
}) {
  function renderEnterpriseNotifications(user, context) {
    app.innerHTML = enterpriseLayout(user, context, `
      ${enterpriseHero('消息通知', '集中查看补正通知、审核结果、政策更新和系统提醒。')}
      <section class="enterprise-card">
        ${emptyBlock('暂无未读消息', '后端消息中心接口接入后，这里会展示与当前企业相关的通知。')}
      </section>
    `);
  }

  return { renderEnterpriseNotifications };
}
