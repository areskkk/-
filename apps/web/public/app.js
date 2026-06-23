import { createEnterpriseFeature } from '/src/features/enterprise/enterprise.js';

const TOKEN_KEY = 'zjb_token';
const USER_KEY = 'zjb_user';
const ROLE_KEY = 'zjb_current_role';
const RESET_PASSWORD_KEY = 'zjb_reset_password_draft';

const roleConfig = {
  enterprise: {
    code: 'enterprise',
    title: '企业用户',
    scope: '企业绑定、政策咨询、资格预判和申报办理',
    home: '/enterprise/dashboard',
  },
  government: {
    code: 'government',
    title: '政府审核人员',
    scope: '审核任务、材料核验、补正通知和审核意见处理',
    home: '/gov/tasks',
  },
  admin: {
    code: 'admin',
    title: '平台管理员',
    scope: '政策管理、系统配置、人工兜底和运行监控',
    home: '/admin/dashboard',
  },
  policy_admin: {
    code: 'policy_admin',
    title: '政策管理员',
    scope: '政策导入、结构化规则配置和发布管理',
    home: '/admin/policies',
  },
};

const registerRoleToEntryRole = {
  enterprise: 'enterprise',
  government_reviewer: 'government',
  platform_admin: 'admin',
  policy_admin: 'policy_admin',
};

const adminRoles = new Set(['system_admin', 'policy_admin', 'kb_operator', 'qa_reviewer']);
const governmentRoles = new Set(['reviewer', 'window_staff', 'department_lead']);
const enterpriseRoles = new Set(['owner', 'manager', 'operator', 'viewer']);

const userTypeLabels = {
  enterprise: '企业用户',
  government: '政府人员',
  admin: '平台管理员',
  development_stub: '开发调试账号',
};

const roleLabels = {
  owner: '企业负责人',
  manager: '企业管理员',
  operator: '企业经办人',
  viewer: '企业查看人',
  system_admin: '系统管理员',
  policy_admin: '政策管理员',
  kb_operator: '知识库运营人员',
  qa_reviewer: '问答复核人员',
  window_staff: '窗口工作人员',
  reviewer: '审核人员',
  department_lead: '部门负责人',
};

const bindingStatusLabels = {
  pending: '待审核',
  agent_approved: '已通过',
  manual_approved: '人工通过',
  rejected: '已拒绝',
  revoked: '已撤销',
};

const app = document.querySelector('#app');
let registerDraft = null;

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function setSession(input) {
  localStorage.setItem(TOKEN_KEY, input.token);
  localStorage.setItem(USER_KEY, JSON.stringify(input.user));
}

function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem(ROLE_KEY);
}

function readStoredUser() {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY) || 'null');
  } catch {
    return null;
  }
}

async function apiFetch(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };
  const token = getToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`/api/v1${path}`, {
    ...options,
    headers,
  });
  const body = await response.json().catch(() => null);
  if (response.status === 401) {
    clearSession();
  }
  if (!response.ok || body?.success === false) {
    const error = new Error(body?.error?.message || '请求失败，请稍后重试');
    error.status = response.status;
    error.code = body?.error?.code;
    error.traceId = body?.trace_id;
    throw error;
  }
  return body.data;
}

async function apiUpload(path, formData) {
  const headers = {};
  const token = getToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const response = await fetch(`/api/v1${path}`, {
    method: 'POST',
    headers,
    body: formData,
  });
  const body = await response.json().catch(() => null);
  if (response.status === 401) {
    clearSession();
  }
  if (!response.ok || body?.success === false) {
    const error = new Error(body?.error?.message || '上传失败，请稍后重试');
    error.status = response.status;
    error.code = body?.error?.code;
    error.traceId = body?.trace_id;
    throw error;
  }
  return body.data;
}

async function loadCurrentUser() {
  const user = await apiFetch('/auth/me');
  localStorage.setItem(USER_KEY, JSON.stringify(user));
  return user;
}

function roleGroups(user) {
  const roles = new Set(user?.roles || []);
  const groups = [];
  if (user?.user_type === 'enterprise' || [...roles].some((role) => enterpriseRoles.has(role))) {
    groups.push(roleConfig.enterprise);
  }
  if (user?.user_type === 'government' || [...roles].some((role) => governmentRoles.has(role))) {
    groups.push(roleConfig.government);
  }
  if (user?.user_type === 'admin' || [...roles].some((role) => adminRoles.has(role))) {
    groups.push(roleConfig.admin);
  }
  if (roles.has('policy_admin')) {
    groups.push(roleConfig.policy_admin);
  }
  return groups.filter((group, index, array) => (
    array.findIndex((item) => item.code === group.code) === index
  ));
}

function defaultRouteFor(user, forcedRole) {
  const groups = roleGroups(user);
  if (forcedRole) {
    const matched = groups.find((group) => group.code === forcedRole);
    if (matched) {
      return matched.home;
    }
  }
  if (groups.length > 1) {
    return '/select-role';
  }
  if (groups.length === 0) {
    return '/403';
  }
  return groups[0].home;
}

function navigate(path) {
  history.pushState({}, '', path);
  render();
}

function replace(path) {
  history.replaceState({}, '', path);
  render();
}

function shell(content, options = {}) {
  const topbar = options.hideTopbar ? '' : `
      <header class="topbar">
        <div class="topbar-inner">
          <a class="brand" href="/" data-link>家助宝公共入口</a>
          <nav class="nav-actions" aria-label="顶部操作">
            <a class="icon-link" href="/404" data-link aria-label="通知">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"></path>
                <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
              </svg>
            </a>
            <a class="icon-link" href="${options.user ? '/profile' : '/login?notice=login-required'}" data-link aria-label="用户">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="8" r="4"></circle>
                <path d="M20 21a8 8 0 0 0-16 0"></path>
              </svg>
            </a>
          </nav>
        </div>
      </header>`;
  const footer = options.hideFooter ? '' : `
      <footer class="site-footer">
        <div>
          <strong>家助宝公共入口</strong>
          <p>© 2026 家助宝。保留所有权利。</p>
        </div>
        <nav class="footer-links" aria-label="页脚链接">
          <a href="/404" data-link>隐私政策</a>
          <a href="/404" data-link>服务条款</a>
          <a href="/404" data-link>无障碍访问</a>
          <a href="/404" data-link>联系支持</a>
        </nav>
      </footer>`;
  return `
    <main class="shell${options.hideTopbar ? ' shell-full' : ''}">
      ${topbar}
      <section class="page${options.fullPage ? ' page-full' : ''}">${content}</section>
      ${footer}
    </main>
  `;
}

function loading(text = '正在加载公共入口') {
  app.innerHTML = `
    <div class="loading">
      <div>
        <div class="spinner"></div>
        <div>${text}</div>
      </div>
    </div>
  `;
}

function portalIntro() {
  return `
    <section class="portal-intro">
      <h1>统一登录，按身份进入对应服务</h1>
      <p>企业用户、政府审核人员和平台管理员使用同一个登录入口。系统会根据账号角色自动进入企业端、政府端或后台管理端。</p>
      <div class="portal-cards">
        <article class="portal-card active">
          <strong>企业端</strong>
          <span>企业用户可注册账号，登录后绑定企业主体并进入政策申报。</span>
        </article>
        <article class="portal-card">
          <strong>政府端</strong>
          <span>政府审核人员可注册或使用已分配账号，进入审核任务和材料核验。</span>
        </article>
        <article class="portal-card">
          <strong>后台管理端</strong>
          <span>管理员可注册或使用已分配账号，进入政策、运营和系统管理。</span>
        </article>
      </div>
      <div class="portal-actions">
        <a class="btn primary" href="/login" data-link>统一登录</a>
        <a class="btn ghost" href="/register" data-link>统一注册</a>
      </div>
    </section>
  `;
}

function renderLogin() {
  const params = new URLSearchParams(location.search);
  const notice = params.get('notice');
  app.innerHTML = shell(`
    <div class="auth-center-layout">
      <section class="auth-card login-card">
        <h2 class="card-title">统一登录</h2>
        <p class="card-subtitle">企业用户、政府审核人员、平台管理员都在这里登录。登录后系统会按账号角色跳转。</p>
        <div id="form-alert" class="alert${notice === 'login-required' ? ' show neutral' : ''}">${notice === 'login-required' ? '请先登录后查看个人账号。' : ''}</div>
        <form id="login-form" class="form">
          <div class="field">
            <label for="loginRole">登录身份</label>
            <select id="loginRole" name="loginRole">
              <option value="">自动识别账号身份</option>
              <option value="enterprise">企业用户</option>
              <option value="government">政府审核人员</option>
              <option value="admin">平台管理员</option>
              <option value="policy_admin">政策管理员</option>
            </select>
            <span class="hint">选择身份后会校验当前账号是否具备对应权限。</span>
          </div>
          <div class="field">
            <label for="phone">手机号</label>
            <input id="phone" name="phone" autocomplete="username" inputmode="tel" placeholder="请输入手机号">
          </div>
          <div class="field">
            <label for="password">密码</label>
            <div class="input-wrap">
              <input id="password" name="password" type="password" autocomplete="current-password" placeholder="请输入密码">
              <button class="password-toggle" type="button" data-toggle-password>显示</button>
            </div>
          </div>
          <label class="check-row">
            <input type="checkbox" name="rememberPhone">
            <span>记住手机号</span>
          </label>
          <button class="btn primary full" type="submit">登录</button>
          <div class="form-footer">
            <a href="/forgot-password" data-link>忘记密码</a>
            <span>还没有账号？<a href="/register" data-link>统一注册</a></span>
          </div>
        </form>
      </section>
    </div>
  `);
  bindPasswordToggles();
  bindLoginForm();
}

function registerFieldValue(name) {
  return registerDraft?.[name] || '';
}

function renderRegister() {
  app.innerHTML = shell(`
    <div class="auth-center-layout">
      <section class="auth-card register-card">
        <h2 class="card-title">统一注册</h2>
        <p class="card-subtitle">先完成账号验证，下一步再设置登录密码。</p>
        <div class="step-indicator" aria-label="注册进度">
          <span class="active">1 账号验证</span>
          <i></i>
          <span>2 设置密码</span>
        </div>
        <div id="form-alert" class="alert"></div>
        <form id="register-verify-form" class="form">
          <div class="field">
            <label for="registerRole">账号类型</label>
            <select id="registerRole" name="registerRole">
              <option value="enterprise" ${registerFieldValue('registerRole') === 'enterprise' ? 'selected' : ''}>企业用户</option>
              <option value="government_reviewer" ${registerFieldValue('registerRole') === 'government_reviewer' ? 'selected' : ''}>政府审核人员</option>
              <option value="platform_admin" ${registerFieldValue('registerRole') === 'platform_admin' ? 'selected' : ''}>平台管理员</option>
              <option value="policy_admin" ${registerFieldValue('registerRole') === 'policy_admin' ? 'selected' : ''}>政策管理员</option>
            </select>
          </div>
          <div class="field">
            <label for="name">姓名</label>
            <input id="name" name="name" autocomplete="name" placeholder="请输入经办人姓名" value="${escapeHtml(registerFieldValue('name'))}">
          </div>
          <div class="field">
            <label for="phone">手机号</label>
            <input id="phone" name="phone" autocomplete="tel" inputmode="tel" placeholder="请输入手机号" value="${escapeHtml(registerFieldValue('phone'))}">
          </div>
          <div class="field">
            <label for="company">企业名称（选填）</label>
            <input id="company" name="company" placeholder="后续企业绑定时可继续完善" value="${escapeHtml(registerFieldValue('company'))}">
          </div>
          <div class="field">
            <label for="creditCode">统一社会信用代码（选填）</label>
            <input id="creditCode" name="creditCode" maxlength="18" placeholder="请输入 18 位信用代码" value="${escapeHtml(registerFieldValue('creditCode'))}">
          </div>
          <div class="field">
            <label for="code">手机验证码</label>
            <div class="input-wrap">
              <input id="code" name="code" inputmode="numeric" placeholder="请输入验证码" value="${escapeHtml(registerFieldValue('code'))}">
              <button class="password-toggle" type="button" id="send-code">发送</button>
            </div>
            <span class="hint">验证码发送后 60 秒内不能重复发送。</span>
          </div>
          <button class="btn primary full" type="submit">下一步</button>
          <div class="form-footer">
            <span>已有账号？<a href="/login" data-link>返回登录</a></span>
          </div>
        </form>
      </section>
    </div>
  `);
  bindRegisterVerifyForm();
  bindSendCode();
}

function renderRegisterPassword() {
  if (!registerDraft) {
    renderRegister();
    return;
  }
  app.innerHTML = shell(`
    <div class="auth-center-layout">
      <section class="auth-card register-card compact-register-card">
        <h2 class="card-title">设置密码</h2>
        <p class="card-subtitle">手机号 ${escapeHtml(registerDraft.phone)} 已完成验证，请设置登录密码。</p>
        <div class="step-indicator" aria-label="注册进度">
          <span>1 账号验证</span>
          <i></i>
          <span class="active">2 设置密码</span>
        </div>
        <div id="form-alert" class="alert"></div>
        <form id="register-password-form" class="form">
          <div class="field">
            <label for="password">密码</label>
            <div class="input-wrap">
              <input id="password" name="password" type="password" autocomplete="new-password" placeholder="至少 8 位，包含字母和数字">
              <button class="password-toggle" type="button" data-toggle-password>显示</button>
            </div>
            <div id="strength" class="strength" data-level="0"><span></span><span></span><span></span></div>
          </div>
          <div class="field">
            <label for="confirmPassword">确认密码</label>
            <input id="confirmPassword" name="confirmPassword" type="password" autocomplete="new-password" placeholder="请再次输入密码">
          </div>
          <label class="check-row">
            <input type="checkbox" name="agreement">
            <span>我已阅读并同意用户协议、隐私说明和数据使用说明。</span>
          </label>
          <button class="btn primary full" type="submit">注册并登录</button>
          <div class="form-footer">
            <button class="text-action" type="button" id="register-back">上一步</button>
            <span>已有账号？<a href="/login" data-link>返回登录</a></span>
          </div>
        </form>
      </section>
    </div>
  `);
  bindPasswordToggles();
  bindRegisterPasswordForm();
}

function bindPasswordToggles() {
  document.querySelectorAll('[data-toggle-password]').forEach((button) => {
    button.addEventListener('click', () => {
      const input = button.parentElement.querySelector('input');
      const nextType = input.type === 'password' ? 'text' : 'password';
      input.type = nextType;
      button.textContent = nextType === 'password' ? '显示' : '隐藏';
    });
  });
}

function showAlert(message) {
  const alert = document.querySelector('#form-alert');
  if (!alert) {
    return;
  }
  alert.textContent = message;
  alert.classList.add('show');
}

function hideAlert() {
  const alert = document.querySelector('#form-alert');
  if (alert) {
    alert.classList.remove('show');
  }
}

function isPhone(value) {
  return /^1[3-9]\d{9}$/.test(value);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function passwordLevel(value) {
  if (!value) {
    return 0;
  }
  let level = value.length >= 8 ? 1 : 0;
  if (/[A-Za-z]/.test(value) && /\d/.test(value)) {
    level += 1;
  }
  if (/[^A-Za-z0-9]/.test(value) || value.length >= 12) {
    level += 1;
  }
  return Math.min(level, 3);
}

function bindLoginForm() {
  const form = document.querySelector('#login-form');
  const remembered = localStorage.getItem('zjb_remember_phone');
  if (remembered) {
    form.phone.value = remembered;
    form.rememberPhone.checked = true;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    hideAlert();
    const phone = form.phone.value.trim();
    const password = form.password.value;
    if (!isPhone(phone)) {
      showAlert('请输入正确的手机号。');
      return;
    }
    if (!password) {
      showAlert('请输入密码。');
      return;
    }
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    button.textContent = '登录中';
    try {
      const data = await apiFetch('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ phone, password }),
      });
      setSession(data);
      if (form.rememberPhone.checked) {
        localStorage.setItem('zjb_remember_phone', phone);
      } else {
        localStorage.removeItem('zjb_remember_phone');
      }
      const user = await loadCurrentUser();
      const params = new URLSearchParams(location.search);
      const redirect = params.get('redirect');
      const selectedRole = form.loginRole.value;
      if (selectedRole) {
        const allowed = roleGroups(user).some((group) => group.code === selectedRole);
        if (!allowed) {
          replace('/403');
          return;
        }
        localStorage.setItem(ROLE_KEY, selectedRole);
      }
      replace(redirect || defaultRouteFor(user, selectedRole));
    } catch (error) {
      form.password.value = '';
      showAlert(toFriendlyError(error));
    } finally {
      button.disabled = false;
      button.textContent = '登录';
    }
  });
}

function bindRegisterVerifyForm() {
  const form = document.querySelector('#register-verify-form');
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    hideAlert();
    const name = form.name.value.trim();
    const phone = form.phone.value.trim();
    const code = form.code.value.trim();
    if (!name) {
      showAlert('请输入姓名。');
      return;
    }
    if (!isPhone(phone)) {
      showAlert('请输入正确的手机号。');
      return;
    }
    if (!code) {
      showAlert('请输入手机验证码。');
      return;
    }
    registerDraft = {
      registerRole: form.registerRole.value,
      name,
      phone,
      company: form.company.value.trim(),
      creditCode: form.creditCode.value.trim(),
      code,
    };
    renderRegisterPassword();
  });
}

function bindRegisterPasswordForm() {
  const form = document.querySelector('#register-password-form');
  const strength = document.querySelector('#strength');
  form.password.addEventListener('input', () => {
    strength.dataset.level = String(passwordLevel(form.password.value));
  });
  document.querySelector('#register-back')?.addEventListener('click', () => {
    renderRegister();
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    hideAlert();
    const password = form.password.value;
    const confirmPassword = form.confirmPassword.value;
    if (!registerDraft) {
      showAlert('请先完成账号验证。');
      return;
    }
    if (passwordLevel(password) < 2) {
      showAlert('密码至少 8 位，并包含字母和数字。');
      return;
    }
    if (password !== confirmPassword) {
      showAlert('两次输入的密码不一致。');
      return;
    }
    if (!form.agreement.checked) {
      showAlert('请先勾选用户协议、隐私说明和数据使用说明。');
      return;
    }
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    button.textContent = '注册中';
    try {
      await apiFetch('/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          name: registerDraft.name,
          phone: registerDraft.phone,
          password,
          role_code: registerDraft.registerRole,
        }),
      });
      const data = await apiFetch('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ phone: registerDraft.phone, password }),
      });
      setSession(data);
      localStorage.setItem('zjb_pending_enterprise', JSON.stringify({
        enterprise_name: registerDraft.company,
        credit_code: registerDraft.creditCode,
      }));
      const user = await loadCurrentUser();
      const selectedRole = registerRoleToEntryRole[registerDraft.registerRole] || '';
      if (selectedRole) {
        localStorage.setItem(ROLE_KEY, selectedRole);
      }
      registerDraft = null;
      replace(defaultRouteFor(user, selectedRole));
    } catch (error) {
      showAlert(toFriendlyError(error));
    } finally {
      button.disabled = false;
      button.textContent = '注册并登录';
    }
  });
}

function bindSendCode() {
  const button = document.querySelector('#send-code');
  if (!button) {
    return;
  }
  button.addEventListener('click', () => {
    if (button.disabled) {
      return;
    }
    let remain = 60;
    button.disabled = true;
    button.textContent = `${remain}秒`;
    const timer = window.setInterval(() => {
      remain -= 1;
      button.textContent = remain > 0 ? `${remain}秒` : '重发';
      if (remain <= 0) {
        button.disabled = false;
        window.clearInterval(timer);
      }
    }, 1000);
  });
}

function toFriendlyError(error) {
  if (error.code === 'CONFLICT') {
    return '该手机号已注册，请直接登录或更换手机号。';
  }
  if (error.code === 'AUTH_REQUIRED') {
    return '账号或密码不正确，请重新输入。';
  }
  if (error.code === 'FORBIDDEN') {
    return '当前账号不可用，请联系管理员处理。';
  }
  return error.message || '操作失败，请稍后重试。';
}

async function renderRoot() {
  loading();
  if (!getToken()) {
    replace('/login');
    return;
  }
  try {
    const user = await loadCurrentUser();
    replace(defaultRouteFor(user, localStorage.getItem(ROLE_KEY)));
  } catch {
    replace('/login');
  }
}

async function renderSelectRole() {
  loading('正在读取身份信息');
  try {
    const user = await loadCurrentUser();
    const groups = roleGroups(user);
    if (groups.length <= 1) {
      replace(defaultRouteFor(user));
      return;
    }
    app.innerHTML = shell(`
      <div class="role-layout">
        <div class="role-header">
          <div>
            <h1>选择本次进入的身份</h1>
            <p>${user.name || '当前用户'}，请选择本次要进入的业务端。选择后会保存为当前身份上下文。</p>
          </div>
          <a class="btn ghost" href="/logout" data-link>退出登录</a>
        </div>
        <div class="role-grid">
          ${groups.map((group) => `
            <article class="role-card">
              <div>
                <span class="badge">${group.title}</span>
                <h2>${group.title}</h2>
                <p>${group.scope}</p>
              </div>
              <button class="btn primary full" data-role="${group.code}">进入${group.title}</button>
            </article>
          `).join('')}
        </div>
      </div>
    `, { user });
    document.querySelectorAll('[data-role]').forEach((button) => {
      button.addEventListener('click', () => {
        const code = button.dataset.role;
        localStorage.setItem(ROLE_KEY, code);
        replace(defaultRouteFor(user, code));
      });
    });
  } catch {
    replace('/login');
  }
}

async function renderProfile() {
  loading('正在读取账号信息');
  try {
    const user = await loadCurrentUser();
    const groups = roleGroups(user);
    app.innerHTML = shell(`
      <div class="profile-layout">
        <div class="profile-header">
          <div>
            <h1>个人账号</h1>
            <p>查看当前登录用户、角色、企业绑定和安全入口。</p>
          </div>
          <a class="btn primary" href="/logout" data-link>退出登录</a>
        </div>
        <div class="profile-grid">
          <section class="profile-card">
            <h2>基础信息</h2>
            <div class="meta-list">
              ${meta('姓名', user.name || '未设置')}
              ${meta('手机号', user.phone || '未绑定')}
              ${meta('账号编号', user.user_id)}
              ${meta('用户类型', userTypeLabels[user.user_type] || '未识别')}
              ${meta('账号状态', user.status === 'active' ? '正常' : user.status)}
            </div>
          </section>
          <section class="profile-card">
            <h2>角色信息</h2>
            <p>${groups.length ? groups.map((group) => group.title).join('、') : '暂无有效角色'}</p>
            <div class="meta-list">
              ${meta('当前身份', localStorage.getItem(ROLE_KEY) || '未手动选择')}
              ${meta('企业绑定', user.has_bound_enterprise ? '已绑定' : '未绑定')}
            </div>
          </section>
          <section class="profile-card">
            <h2>企业 / 部门</h2>
            ${renderEnterpriseBindings(user.enterprise_bindings || [])}
          </section>
          <section class="profile-card">
            <h2>安全设置</h2>
            <p>可进行密码维护、设备安全和身份切换等账号安全操作。</p>
            <div class="result-actions" style="justify-content:flex-start;margin-top:18px">
              <a class="btn ghost" href="/reset-password" data-link>修改密码</a>
              <a class="btn ghost" href="/select-role" data-link>切换身份</a>
            </div>
          </section>
        </div>
      </div>
    `, { user });
  } catch {
    replace('/login');
  }
}

function meta(label, value) {
  return `<div class="meta-item"><span class="meta-label">${label}</span><span class="meta-value">${value || '-'}</span></div>`;
}

function renderEnterpriseBindings(bindings) {
  if (!bindings.length) {
    return '<p>当前账号尚未绑定企业主体。</p><div class="result-actions" style="justify-content:flex-start;margin-top:18px"><a class="btn primary" href="/enterprise/bind" data-link>去绑定企业</a></div>';
  }
  return `
    <div class="meta-list">
      ${bindings.map((binding) => meta(
        binding.name,
        `${roleLabels[binding.role] || binding.role} / ${bindingStatusLabels[binding.auth_status] || binding.auth_status}`,
      )).join('')}
    </div>
  `;
}

function renderResetPassword() {
  renderSimpleForm({
    title: '重置密码',
    subtitle: '设置新密码后需要重新登录。',
    button: '提交新密码',
    fields: [
      ['password', '新密码', '至少 8 位，包含字母和数字', 'password'],
      ['confirmPassword', '确认密码', '请再次输入新密码', 'password'],
    ],
    async submit(form) {
      const draft = readResetPasswordDraft();
      if (!draft?.phone) {
        showAlert('请先完成手机号验证。');
        return;
      }
      const password = form.password.value;
      if (passwordLevel(password) < 2) {
        showAlert('密码至少 8 位，并包含字母和数字。');
        return;
      }
      if (password !== form.confirmPassword.value) {
        showAlert('两次输入的密码不一致。');
        return;
      }
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      button.textContent = '提交中';
      try {
        await apiFetch('/auth/reset-password', {
          method: 'POST',
          body: JSON.stringify({
            phone: draft.phone,
            code: draft.code,
            password,
          }),
        });
        localStorage.removeItem(RESET_PASSWORD_KEY);
        clearSession();
        navigate('/login');
      } catch (error) {
        showAlert(toFriendlyError(error));
      } finally {
        button.disabled = false;
        button.textContent = '提交新密码';
      }
    },
    hint: '重置成功后将清理当前登录状态，请使用新密码重新登录。',
  });
}

function renderForgotPassword() {
  renderSimpleForm({
    title: '找回密码',
    subtitle: '请输入手机号并完成验证码校验后重置密码。',
    button: '下一步',
    fields: [
      ['account', '手机号或账号', '请输入手机号或账号'],
      ['code', '验证码', '请输入验证码'],
    ],
    submit(form) {
      const phone = form.account.value.trim();
      const code = form.code.value.trim();
      if (!isPhone(phone)) {
        showAlert('请输入正确的手机号。');
        return;
      }
      if (!code) {
        showAlert('请输入验证码。');
        return;
      }
      localStorage.setItem(RESET_PASSWORD_KEY, JSON.stringify({ phone, code }));
      navigate('/reset-password');
    },
    hint: '政府人员和管理员账号如无法自助找回，请联系系统管理员重置。',
  });
}

function readResetPasswordDraft() {
  try {
    return JSON.parse(localStorage.getItem(RESET_PASSWORD_KEY) || 'null');
  } catch {
    return null;
  }
}

function renderSimpleForm(config) {
  app.innerHTML = shell(`
    <div class="auth-center-layout">
      <section class="auth-card simple-card">
        <h2 class="card-title">${config.title}</h2>
        <p class="card-subtitle">${config.subtitle}</p>
        <div id="form-alert" class="alert"></div>
        <form id="simple-form" class="form">
          ${config.fields.map(([name, label, placeholder, type = 'text']) => `
            <div class="field">
              <label for="${name}">${label}</label>
              <input id="${name}" name="${name}" type="${type}" placeholder="${placeholder}">
            </div>
          `).join('')}
          <p class="hint">${config.hint}</p>
          <button class="btn primary full" type="submit">${config.button}</button>
          <div class="form-footer"><a href="/login" data-link>返回登录</a></div>
        </form>
      </section>
    </div>
  `);
  const form = document.querySelector('#simple-form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    hideAlert();
    await config.submit(form);
  });
}

function renderErrorPage(code, title, text, actions = []) {
  const user = readStoredUser();
  app.innerHTML = shell(`
    <div class="compact-page">
      <section class="result-card">
        <div class="result-code">${code}</div>
        <h1 class="result-title">${title}</h1>
        <p class="result-text">${text}</p>
        <div class="result-actions">
          <button class="btn ghost" type="button" id="back-btn">返回上一页</button>
          <a class="btn primary" href="/" data-link>返回入口</a>
          ${actions.join('')}
        </div>
      </section>
    </div>
  `, { user });
  document.querySelector('#back-btn')?.addEventListener('click', () => history.back());
}

async function renderLogout() {
  loading('正在退出登录');
  try {
    if (getToken()) {
      await apiFetch('/auth/logout', { method: 'POST', body: '{}' });
    }
  } catch {
    // Local cleanup is the source of truth for logout.
  }
  clearSession();
  replace('/login');
}

function isBusinessRoute(path) {
  return path.startsWith('/enterprise') || path.startsWith('/gov') || path.startsWith('/admin');
}

const enterpriseFeature = createEnterpriseFeature({
  app,
  apiFetch,
  apiUpload,
  escapeHtml,
  getToken,
  hideAlert,
  loadCurrentUser,
  navigate,
  replace,
  roleGroups,
  shell,
  showAlert,
  toFriendlyError,
});

async function renderBusinessPlaceholder(path) {
  if (!getToken()) {
    replace(`/login?redirect=${encodeURIComponent(path)}`);
    return;
  }
  try {
    const user = await loadCurrentUser();
    const target = defaultRouteFor(user, localStorage.getItem(ROLE_KEY));
    const allowed =
      (path.startsWith('/enterprise') && roleGroups(user).some((role) => role.code === 'enterprise')) ||
      (path.startsWith('/gov') && roleGroups(user).some((role) => role.code === 'government')) ||
      (path.startsWith('/admin') && roleGroups(user).some((role) => role.code === 'admin' || role.code === 'policy_admin'));
    if (!allowed) {
      replace('/403');
      return;
    }
    const title = path.startsWith('/gov')
      ? '政府端页面待接入'
      : path.startsWith('/admin')
        ? '后台管理端页面待接入'
        : '企业端页面待接入';
    renderErrorPage('入口', title, `公共入口已完成登录态和权限识别，当前目标地址为 ${path}。`, [
      `<a class="btn ghost" href="${target}" data-link>进入默认首页</a>`,
    ]);
  } catch {
    replace('/login');
  }
}

async function render() {
  const path = window.location.pathname;
  if (path === '/') {
    await renderRoot();
    return;
  }
  if (path === '/login') {
    renderLogin();
    return;
  }
  if (path === '/register') {
    renderRegister();
    return;
  }
  if (path === '/select-role') {
    await renderSelectRole();
    return;
  }
  if (path === '/forgot-password') {
    renderForgotPassword();
    return;
  }
  if (path === '/reset-password') {
    renderResetPassword();
    return;
  }
  if (path === '/profile') {
    await renderProfile();
    return;
  }
  if (path === '/logout') {
    await renderLogout();
    return;
  }
  if (path === '/403') {
    renderErrorPage('403', '无权限访问', '当前账号无权访问该页面。请确认身份是否正确，或联系管理员开通权限。', [
      '<a class="btn ghost" href="/select-role" data-link>切换身份</a>',
    ]);
    return;
  }
  if (path === '/500') {
    renderErrorPage('500', '系统暂时不可用', '服务繁忙或接口异常，请稍后重试。若问题持续，请提供追踪编号给管理员。');
    return;
  }
  if (path.startsWith('/enterprise')) {
    await enterpriseFeature.renderEnterprisePage(path);
    return;
  }
  if (isBusinessRoute(path)) {
    await renderBusinessPlaceholder(path);
    return;
  }
  renderErrorPage('404', '页面不存在', '访问的页面不存在或链接已失效，请返回入口重新进入。');
}

document.addEventListener('click', (event) => {
  const link = event.target.closest('a[data-link]');
  if (!link) {
    return;
  }
  const url = new URL(link.href);
  if (url.origin !== location.origin) {
    return;
  }
  event.preventDefault();
  navigate(`${url.pathname}${url.search}`);
});

window.addEventListener('popstate', render);

render();
