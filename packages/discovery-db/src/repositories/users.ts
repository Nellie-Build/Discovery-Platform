import type { Queryable } from '../connection.js';

export interface User {
  id: string;
  email: string;
  password_hash: string;
  created_at: Date;
  updated_at: Date;
}

export type PublicUser = Omit<User, 'password_hash'>;

export class UsersRepository {
  constructor(private readonly db: Queryable) {}

  async createUser(email: string, passwordHash: string): Promise<User> {
    const { rows } = await this.db.query<User>(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING *', [email.toLowerCase(), passwordHash],
    );
    return rows[0];
  }

  async getUserByEmail(email: string): Promise<User | null> {
    const { rows } = await this.db.query<User>('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    return rows[0] ?? null;
  }

  async getUserById(id: string): Promise<User | null> {
    const { rows } = await this.db.query<User>('SELECT * FROM users WHERE id = $1', [id]);
    return rows[0] ?? null;
  }
}

export function toPublicUser(user: User): PublicUser {
  const { password_hash: _password_hash, ...publicUser } = user;
  return publicUser;
}
