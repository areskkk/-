export function buildBusinessLicenseSuccessFixture(): string {
  return JSON.stringify({
    material_type: 'business_license',
    fields: {
      enterprise_name: '南康某家具有限公司',
      credit_code: '913607XX0000000000',
      legal_person: '张三',
      registered_address: '江西省赣州市南康区',
      business_scope: '家具制造；家具销售',
      valid_period: {
        start_date: '2020-01-01',
        end_date: null,
        long_term: true,
      },
    },
    field_confidence: {
      enterprise_name: 0.96,
      credit_code: 0.95,
      legal_person: 0.93,
      registered_address: 0.91,
      business_scope: 0.9,
      valid_period: 0.92,
    },
    overall_confidence: 0.94,
    warnings: [],
  });
}

export function buildBusinessLicenseLowConfidenceFixture(): string {
  return JSON.stringify({
    material_type: 'business_license',
    fields: {
      enterprise_name: '南康某家具有限公司',
      credit_code: '913607XX0000000000',
      legal_person: '张三',
      registered_address: '江西省赣州市南康区',
      business_scope: '家具制造；家具销售',
      valid_period: {
        start_date: '2020-01-01',
        end_date: null,
        long_term: true,
      },
    },
    field_confidence: {
      enterprise_name: 0.92,
      credit_code: 0.82,
      legal_person: 0.91,
      registered_address: 0.9,
      business_scope: 0.88,
      valid_period: 0.9,
    },
    overall_confidence: 0.82,
    warnings: ['credit_code low confidence; manual confirmation required'],
  });
}
