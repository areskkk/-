export function createEnterpriseQaPage({
  app,
  apiFetch,
  enterpriseHero,
  enterpriseLayout,
  escapeHtml,
  toFriendlyError,
}) {
  function renderEnterpriseQa(user, context) {
    app.innerHTML = enterpriseLayout(user, context, `
      ${enterpriseHero('企业政策服务', '输入您关注的政策领域或企业现状，我将为您精准匹配并解读相关扶持条款。', '<a class="btn ghost" href="/enterprise/dashboard" data-link>Dashboard</a>', { kicker: 'Policy Assistant' })}
      <section class="qa-workspace">
        <aside class="enterprise-card qa-history-panel">
          <button class="btn primary full" id="qa-new-thread" type="button">开启新会话</button>
          <div class="qa-history-list">
            <span class="card-kicker">最近对话</span>
            ${renderHistoryItem('软件企业研发补贴', '北京市研发费用加计扣除与专项奖励')}
            ${renderHistoryItem('高新技术企业认定', '企业画像缺少专利与研发人员字段')}
            ${renderHistoryItem('数字化转型补助', '推荐进入资格预判流程')}
          </div>
          <a class="text-action" href="/enterprise/qa" data-link>查看全部历史</a>
        </aside>

        <section class="enterprise-card qa-card qa-chat-panel">
          <div class="qa-chat-title">
            <div>
              <span class="card-kicker">我是您的政策智能助手</span>
              <h2>精准解读政策条款与申报路径</h2>
            </div>
            <b class="status-badge approved">Online</b>
          </div>
          <div id="qa-thread" class="qa-thread">
            ${renderInitialAnswer()}
          </div>
          <div class="quick-question-row">
            <button type="button" data-question="请问2024年北京市针对软件企业的研发经费投入有具体的资金补助政策吗？">研发费用补助</button>
            <button type="button" data-question="我们是否符合高新技术企业申报条件？">资格预判</button>
            <button type="button" data-question="申报研发创新补贴需要哪些材料？">材料清单</button>
          </div>
          <form id="enterprise-qa-form" class="qa-input-row">
            <textarea name="question" rows="1" placeholder="输入您关注的政策领域、企业现状或申报问题"></textarea>
            <button class="btn primary" type="submit">发送</button>
          </form>
        </section>

        <aside class="enterprise-card qa-suggestion-panel">
          <span class="card-kicker">下一步建议</span>
          <a class="suggestion-card primary" href="/enterprise/applications/new" data-link>
            <strong>发起资格预判</strong>
            <span>选择政策并创建申报草稿</span>
          </a>
          <a class="suggestion-card" href="/enterprise/profile" data-link>
            <strong>完善企业画像</strong>
            <span>补齐经营、研发和资质字段</span>
          </a>
          <button class="suggestion-card" id="human-specialist" type="button">
            <strong>人工政策专员</strong>
            <span>预约专员协助解读政策</span>
          </button>
          <div class="qa-tip">
            <strong>小贴士</strong>
            <p>问题越具体，系统越容易返回有引用依据的政策条款。</p>
          </div>
        </aside>
      </section>
    `);
    bindEnterpriseQaForm();
    bindQaPrototypeControls();
  }

  function renderHistoryItem(title, text) {
    return `
      <button class="qa-history-item" type="button" data-question="${escapeHtml(title)}">
        <strong>${escapeHtml(title)}</strong>
        <span>${escapeHtml(text)}</span>
      </button>
    `;
  }

  function renderInitialAnswer() {
    return `
      <div class="qa-question">请问2024年北京市针对软件企业的研发经费投入有具体的资金补助政策吗？</div>
      <div class="qa-answer featured">
        <strong>2024年度北京市研发费用加计扣除与专项奖励</strong>
        <p>根据当前政策口径，软件企业可重点关注研发费用加计扣除、科技型中小企业创新资金和区级研发投入奖励。若企业画像中的研发投入、专利数量和纳税记录完整，系统可继续发起资格预判。</p>
        <div class="qa-answer-grid">
          <span><b>资金补贴</b>最高按研发投入强度分档支持</span>
          <span><b>税收优惠</b>研发费用可按规定加计扣除</span>
          <span><b>适用条件</b>需具备研发活动、财务归集和知识产权材料</span>
        </div>
        <small>引用来源：《北京市促进科技创新若干措施》《企业研发费用税前加计扣除政策指引》</small>
      </div>
    `;
  }

  function bindEnterpriseQaForm() {
    const form = document.querySelector('#enterprise-qa-form');
    const thread = document.querySelector('#qa-thread');
    const textarea = form?.question;
    textarea?.addEventListener('input', () => {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 150)}px`;
    });
    form?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const question = form.question.value.trim();
      if (!question) return;
      thread.insertAdjacentHTML('beforeend', `<div class="qa-question">${escapeHtml(question)}</div>`);
      form.question.value = '';
      form.question.style.height = 'auto';
      try {
        const result = await apiFetch('/policy-qa', {
          method: 'POST',
          body: JSON.stringify({ question }),
        });
        const answerNode = appendAnswer(thread, result, '正在分析政策依据');
        const pollUrl = result.scoring?.poll_url;
        if (pollUrl) {
          await pollAgentAnswer(pollUrl, answerNode);
        }
      } catch (error) {
        thread.insertAdjacentHTML('beforeend', `<div class="qa-answer error-text">${escapeHtml(toFriendlyError(error))}</div>`);
      }
      thread.scrollTop = thread.scrollHeight;
    });
  }

  function bindQaPrototypeControls() {
    const form = document.querySelector('#enterprise-qa-form');
    const thread = document.querySelector('#qa-thread');
    document.querySelectorAll('[data-question]').forEach((button) => {
      button.addEventListener('click', () => {
        if (!form) return;
        form.question.value = button.dataset.question || button.textContent.trim();
        form.requestSubmit();
      });
    });
    document.querySelector('#qa-new-thread')?.addEventListener('click', () => {
      if (thread) {
        thread.innerHTML = '<div class="qa-answer"><strong>智能助手</strong><p>新会话已开启，请输入您关注的政策领域或企业现状。</p></div>';
      }
    });
    document.querySelector('#human-specialist')?.addEventListener('click', () => {
      thread?.insertAdjacentHTML('beforeend', '<div class="qa-answer"><strong>人工政策专员</strong><p>已为您记录预约意向，专员将在工作时间内通过平台消息联系您。</p></div>');
    });
  }

  function appendAnswer(thread, result, pendingTitle = '') {
    const title = pendingTitle || answerTitle(result.status);
    thread.insertAdjacentHTML('beforeend', `
      <div class="qa-answer">
        <strong>${title}</strong>
        <p>${escapeHtml(result.answer || '正在处理，请稍候。')}</p>
        ${renderCitations(result.citations || [])}
      </div>
    `);
    return thread.lastElementChild;
  }

  function updateAnswer(node, result) {
    node.innerHTML = `
      <strong>${answerTitle(result.status)}</strong>
      <p>${escapeHtml(result.answer || '暂未生成可用回答。')}</p>
      ${renderCitations(result.citations || [])}
    `;
  }

  function answerTitle(status) {
    if (status === 'answered') {
      return '已找到政策依据';
    }
    if (status === 'manual_review') {
      return '已转人工复核';
    }
    return '需要进一步确认';
  }

  function renderCitations(citations) {
    return citations
      .map((item) => `<small>引用：《${escapeHtml(item.title || '政策依据')}》 ${escapeHtml(item.snippet || '')}</small>`)
      .join('');
  }

  async function pollAgentAnswer(pollUrl, answerNode) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await delay(attempt < 4 ? 1500 : 3000);
      const run = await apiFetch(stripApiPrefix(pollUrl));
      if (run.status === 'queued' || run.status === 'running' || run.status === 'resuming') {
        answerNode.querySelector('p').textContent = `正在分析政策依据，当前节点：${run.current_node || '排队中'}`;
        continue;
      }
      updateAnswer(answerNode, agentRunToQaResult(run));
      return;
    }
    answerNode.innerHTML = `
      <strong>仍在处理中</strong>
      <p>政策问答任务还在运行，请稍后重新进入政策问答查看，或再次提交问题。</p>
    `;
  }

  function stripApiPrefix(url) {
    return url.startsWith('/api/v1') ? url.slice('/api/v1'.length) : url;
  }

  function agentRunToQaResult(run) {
    if (run.status === 'completed') {
      const citations = normalizeCitations(run.state?.final?.citations || run.state?.retrieval?.citations || []);
      return {
        status: citations.length > 0 || run.state?.final?.answer ? 'answered' : 'manual_review',
        answer: run.state?.final?.answer
          || run.state?.policy_analysis?.answer
          || firstCitationAnswer(citations)
          || '未找到可直接引用的政策依据，已建议转人工复核。',
        citations,
      };
    }
    if (run.status === 'interrupted') {
      return {
        status: 'manual_review',
        answer: '当前问题需要人工复核，系统已保留本次咨询上下文。',
        citations: normalizeCitations(run.state?.retrieval?.citations || []),
      };
    }
    return {
      status: 'manual_review',
      answer: run.error_message || '政策问答任务未能完成，请稍后重试。',
      citations: [],
    };
  }

  function normalizeCitations(citations) {
    return citations.map((item) => ({
      title: item.title || item.policy_title || item.source_name || '政策依据',
      snippet: item.snippet || item.content || item.text || item.summary || '',
    }));
  }

  function firstCitationAnswer(citations) {
    const first = citations[0];
    return first ? `根据《${first.title}》，${first.snippet}` : '';
  }

  function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  return { renderEnterpriseQa };
}
