import {
  type AccountRoleValue,
  type ApplicationStatusValue,
  type BindingStatusValue,
  type EligibilityResultValue,
  type EnterpriseStatusValue,
  type OcrStatusValue,
  type PolicyStatusValue,
  type SecurityLevelValue,
} from './enums.js';

export type Enterprise = {
  enterprise_id: string;
  name: string;
  credit_code: string;
  legal_person?: string;
  status: EnterpriseStatusValue;
};

export type EnterpriseAccount = {
  account_id: string;
  enterprise_id: string;
  user_id: string;
  role: AccountRoleValue;
  auth_status: BindingStatusValue;
};

export type Policy = {
  policy_id: string;
  title: string;
  department_id?: string;
  status: PolicyStatusValue;
  version: string;
};

export type Application = {
  application_id: string;
  enterprise_id: string;
  applicant_user_id: string;
  profile_snapshot_id: string;
  status: ApplicationStatusValue;
};

export type ApplicationPolicyItem = {
  item_id: string;
  application_id: string;
  policy_id: string;
  status: ApplicationStatusValue;
  eligibility_result?: EligibilityResultValue;
};

export type Material = {
  material_id: string;
  application_id: string;
  material_type: string;
  file_id: string;
  file_hash: string;
  ocr_status: OcrStatusValue;
  security_level: SecurityLevelValue;
};
