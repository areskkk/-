export type JwtClaims = {
  sub: string;
  roles: string[];
  user_type: string;
};

export type RegisterRequest = {
  name: string;
  phone: string;
  password: string;
  user_type?: string;
  role_code?: string;
};

export type LoginRequest = {
  phone: string;
  password: string;
};

export type ResetPasswordRequest = {
  phone: string;
  password: string;
  code?: string;
};
