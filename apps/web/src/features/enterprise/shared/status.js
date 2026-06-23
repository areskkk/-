export const applicationStatusLabels = {
  draft: '草稿',
  submitted: '已提交',
  pre_reviewing: '预审中',
  reviewing: '审核中',
  need_supplement: '需补正',
  resubmitted: '已补正',
  manual_review: '人工复核中',
  approved: '已通过',
  rejected: '不通过',
  withdrawn: '已撤回',
  timeout_closed: '超时关闭',
  archived: '已归档',
};

export const bindingStatusLabels = {
  pending: '待审核',
  agent_approved: '已通过',
  manual_approved: '人工通过',
  rejected: '已拒绝',
  revoked: '已撤销',
};

export const userTypeLabels = {
  enterprise: '企业用户',
  government: '政府人员',
  admin: '平台管理员',
  development_stub: '开发调试账号',
};

export function statusText(status, map = applicationStatusLabels) {
  return map[status] || status || '未知';
}
