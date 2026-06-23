import { query, queryOne } from '../../db/query.js';

export type UserRow = {
  user_id: string;
  name: string;
  phone: string | null;
  password_hash: string | null;
  user_type: string;
  status: string;
  created_at?: Date;
};

export type UserRoleRow = {
  code: string;
};

export async function insertUser(input: {
  name: string;
  phone: string;
  password_hash: string;
  user_type: string;
}): Promise<UserRow> {
  const user = await queryOne<UserRow>(
    `
      INSERT INTO users (name, phone, password_hash, user_type)
      VALUES ($1, $2, $3, $4)
      RETURNING user_id, name, phone, password_hash, user_type, status
    `,
    [input.name, input.phone, input.password_hash, input.user_type],
  );

  if (!user) {
    throw new Error('Failed to create user');
  }

  return user;
}

export async function findUserByPhone(phone: string): Promise<UserRow | undefined> {
  return queryOne<UserRow>(
    `
      SELECT user_id, name, phone, password_hash, user_type, status
      FROM users
      WHERE phone = $1
    `,
    [phone],
  );
}

export async function findUserById(userId: string): Promise<UserRow | undefined> {
  return queryOne<UserRow>(
    `
      SELECT user_id, name, phone, password_hash, user_type, status, created_at
      FROM users
      WHERE user_id = $1
    `,
    [userId],
  );
}

export async function updateUserPasswordHash(input: {
  user_id: string;
  password_hash: string;
}): Promise<void> {
  await query(
    `
      UPDATE users
      SET password_hash = $2
      WHERE user_id = $1
    `,
    [input.user_id, input.password_hash],
  );
}

export async function assignRole(userId: string, roleCode: string): Promise<void> {
  await query(
    `
      INSERT INTO user_roles (user_id, role_id)
      SELECT $1, role_id
      FROM roles
      WHERE code = $2
      ON CONFLICT (user_id, role_id) DO NOTHING
    `,
    [userId, roleCode],
  );
}

export async function findRoleCodesByUserId(userId: string): Promise<string[]> {
  const rows = await query<UserRoleRow>(
    `
      SELECT r.code
      FROM user_roles ur
      INNER JOIN roles r ON r.role_id = ur.role_id
      WHERE ur.user_id = $1
      ORDER BY r.code ASC
    `,
    [userId],
  );

  return rows.map((row) => row.code);
}
