import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';

export interface AuthUser {
  id: string;
  username: string;
}

export interface AuthSession {
  token: string;
  user: AuthUser;
}

const DEFAULT_USERS = ['aniela', 'pawel', 'jarek', 'piotr'];
const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

function hashPassword(password: string, salt = randomBytes(16).toString('hex')): string {
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password: string, storedHash: string): boolean {
  const [algorithm, salt, expectedHash] = storedHash.split(':');
  if (algorithm !== 'scrypt' || !salt || !expectedHash) return false;

  const actual = Buffer.from(scryptSync(password, salt, 64).toString('hex'), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function getBearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() || null;
}

function getUserBySessionToken(db: Database.Database, token: string): AuthUser | null {
  const row = db
    .prepare(
      `SELECT
        user.id,
        user.username,
        session.expires_at AS expiresAt
       FROM app_sessions session
       JOIN app_users user ON user.id = session.user_id
       WHERE session.token = ?`,
    )
    .get(token) as { id: string; username: string; expiresAt: string | null } | undefined;

  if (!row) return null;

  if (row.expiresAt && Date.parse(row.expiresAt) <= Date.now()) {
    db.prepare('DELETE FROM app_sessions WHERE token = ?').run(token);
    return null;
  }

  return { id: row.id, username: row.username };
}

function readAuthenticatedUser(db: Database.Database, request: FastifyRequest): AuthUser | null {
  const token = getBearerToken(request);
  return token ? getUserBySessionToken(db, token) : null;
}

export function ensureDefaultUsers(db: Database.Database): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO app_users (id, username, password_hash)
     VALUES (?, ?, ?)`,
  );

  const tx = db.transaction(() => {
    for (const username of DEFAULT_USERS) {
      insert.run(randomUUID(), username, hashPassword(username));
    }
  });

  tx();
}

export function authenticateUser(
  db: Database.Database,
  username: string,
  password: string,
): AuthUser | null {
  const normalizedUsername = normalizeUsername(username);
  const row = db
    .prepare('SELECT id, username, password_hash AS passwordHash FROM app_users WHERE username = ?')
    .get(normalizedUsername) as { id: string; username: string; passwordHash: string } | undefined;

  if (!row || !verifyPassword(password, row.passwordHash)) return null;
  return { id: row.id, username: row.username };
}

export function createSession(db: Database.Database, user: AuthUser): AuthSession {
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS).toISOString();

  db.prepare(
    `INSERT INTO app_sessions (token, user_id, expires_at)
     VALUES (?, ?, ?)`,
  ).run(token, user.id, expiresAt);

  return { token, user };
}

export function deleteSession(db: Database.Database, token: string): void {
  db.prepare('DELETE FROM app_sessions WHERE token = ?').run(token);
}

export function registerAuthRoutes(app: FastifyInstance, db: Database.Database): void {
  app.post('/api/auth/login', async (request, reply) => {
    const body = (request.body ?? {}) as { username?: unknown; password?: unknown };
    const username = typeof body.username === 'string' ? body.username : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const user = authenticateUser(db, username, password);

    if (!user) return reply.status(401).send({ error: 'Nieprawidlowy login albo haslo' });
    return createSession(db, user);
  });

  app.get('/api/auth/me', async (request, reply) => {
    const user = readAuthenticatedUser(db, request);
    if (!user) return reply.status(401).send({ error: 'Unauthorized' });
    return { user };
  });

  app.post('/api/auth/logout', async (request) => {
    const token = getBearerToken(request);
    if (token) deleteSession(db, token);
    return { ok: true };
  });
}

export function registerAuthGuard(app: FastifyInstance, db: Database.Database): void {
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.url.startsWith('/api/')) return;
    if (request.url.startsWith('/api/auth/')) return;

    const user = readAuthenticatedUser(db, request);
    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
  });
}
