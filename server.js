'use strict';

// 利根沼田 下校時刻共有システム（プロトタイプ）
// 外部ライブラリ不要。`node server.js` で起動します。

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Store, AppError } = require('./lib/store');
const { seed } = require('./lib/seed');

const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const BODY_LIMIT = 256 * 1024;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_LOCK_MS = 10 * 60 * 1000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

// 全レスポンス共通のセキュリティヘッダ。検索エンジンにも載せない（防犯上、下校時刻を広く出さない）
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
};

function createApp({ store }) {
  const sessions = new Map(); // token -> { userId, expires }
  const streams = new Map(); // orgId -> Set<res>
  const loginFailures = new Map(); // loginId -> { count, lockedUntil }
  const routes = [];

  function route(method, pattern, handler, { role = 'any' } = {}) {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)'))}$`);
    routes.push({ method, re, keys, handler, role });
  }

  // ---- 通知（Server-Sent Events） ----

  function notify(orgId, event, payload) {
    const set = streams.get(orgId);
    if (!set) return;
    const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of set) res.write(data);
  }

  // ---- 認証 ----

  function parseCookies(req) {
    const out = {};
    for (const part of (req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
  }

  function currentUser(req) {
    const token = parseCookies(req).sid;
    const s = token && sessions.get(token);
    if (!s) return null;
    if (s.expires < Date.now()) {
      sessions.delete(token);
      return null;
    }
    return store.user(s.userId);
  }

  function endSessionsOf(userId) {
    for (const [token, s] of sessions) if (s.userId === userId) sessions.delete(token);
  }

  function publicMe(user) {
    const org = store.org(user.orgId);
    return {
      user: { id: user.id, name: user.name, loginId: user.loginId },
      org: { id: org.id, type: org.type, name: org.name, municipality: org.municipality },
    };
  }

  // ---- API：共通 ----

  route('POST', '/api/login', ({ body, res }) => {
    const loginId = String(body.loginId || '');
    let f = loginFailures.get(loginId);
    if (f && f.lockedUntil && f.lockedUntil <= Date.now()) f = null; // ロック期間が明けたらリセット
    if (f && f.lockedUntil > Date.now()) {
      throw new AppError('ログインに続けて失敗したため、10分間ログインできません', 429);
    }
    const user = store.verifyLogin(loginId, String(body.password || ''));
    if (!user) {
      const count = (f ? f.count : 0) + 1;
      loginFailures.set(loginId, { count, lockedUntil: count >= LOGIN_MAX_FAILURES ? Date.now() + LOGIN_LOCK_MS : 0 });
      throw new AppError('ログインIDまたはパスワードが違います', 401);
    }
    loginFailures.delete(loginId);
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, { userId: user.id, expires: Date.now() + SESSION_TTL_MS });
    res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
    return publicMe(user);
  }, { role: 'public' });

  route('POST', '/api/logout', ({ req, res }) => {
    const token = parseCookies(req).sid;
    if (token) sessions.delete(token);
    res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    return { ok: true };
  }, { role: 'public' });

  route('GET', '/api/me', ({ user }) => publicMe(user));

  route('POST', '/api/password', ({ user, body }) => {
    store.changePassword(user.id, String(body.current || ''), body.next);
    store.save();
    return { ok: true };
  });

  route('GET', '/api/events', ({ org, req, res }) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('event: hello\ndata: {}\n\n');
    if (!streams.has(org.id)) streams.set(org.id, new Set());
    streams.get(org.id).add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      streams.get(org.id).delete(res);
    });
    return undefined; // レスポンスは開いたまま
  });

  // ---- API：学校 ----

  route('GET', '/api/school/month', ({ org, query }) => ({
    entries: store.schoolMonth(org.id, query.get('month') || ''),
    pending: store.pendingSummary(org.id),
  }), { role: 'school' });

  route('PUT', '/api/school/entries', ({ org, body }) => {
    const pending = store.saveDrafts(org.id, body.days);
    store.save();
    return { pending };
  }, { role: 'school' });

  route('POST', '/api/school/discard', ({ org }) => {
    const pending = store.discardDrafts(org.id);
    store.save();
    return { pending };
  }, { role: 'school' });

  route('POST', '/api/school/publish', ({ org, user, body }) => {
    const release = store.publish(org.id, user.id, body.message);
    store.save();
    const decorated = store.decorateRelease(release);
    const forGakudo = { ...decorated, acks: undefined, ackedAt: null };
    for (const gakudoId of release.recipients) notify(gakudoId, 'release', forGakudo);
    return decorated;
  }, { role: 'school' });

  route('GET', '/api/school/releases', ({ org }) => store.releasesForSchool(org.id), { role: 'school' });

  route('GET', '/api/school/links', ({ org }) => store.linksForSchool(org.id), { role: 'school' });

  route('POST', '/api/school/links/:id', ({ org, user, params, body }) => {
    const link = store.decideLink(org.id, params.id, body.approve === true, user.id);
    store.save();
    notify(link.gakudoId, 'link', { schoolId: org.id, status: link.status });
    return link;
  }, { role: 'school' });

  route('GET', '/api/school/parent-link', ({ org }) => store.parentLink(org.id), { role: 'school' });

  route('POST', '/api/school/parent-link', ({ org, body }) => {
    const link = store.setParentLink(org.id, { enabled: body.enabled, regenerate: body.regenerate === true });
    store.save();
    return link;
  }, { role: 'school' });

  // ---- API：学童 ----

  route('GET', '/api/gakudo/schools', () =>
    store.schools().map(({ id, name, municipality }) => ({ id, name, municipality })), { role: 'gakudo' });

  route('GET', '/api/gakudo/links', ({ org }) => store.linksForGakudo(org.id), { role: 'gakudo' });

  route('POST', '/api/gakudo/links', ({ org, body }) => {
    const link = store.requestLink(org.id, String(body.schoolId || ''));
    store.save();
    notify(link.schoolId, 'link-request', { gakudoId: org.id });
    return link;
  }, { role: 'gakudo' });

  route('DELETE', '/api/gakudo/links/:schoolId', ({ org, params }) => {
    store.cancelLink(org.id, params.schoolId);
    store.save();
    return { ok: true };
  }, { role: 'gakudo' });

  route('GET', '/api/gakudo/schedule', ({ org, query }) =>
    store.gakudoSchedule(org.id, query.get('from') || '', query.get('to') || ''), { role: 'gakudo' });

  route('GET', '/api/gakudo/releases', ({ org }) => store.releasesForGakudo(org.id), { role: 'gakudo' });

  route('POST', '/api/gakudo/releases/:id/ack', ({ org, params }) => {
    const release = store.acknowledge(params.id, org.id);
    store.save();
    notify(release.schoolId, 'ack', { releaseId: release.id, gakudoId: org.id });
    return { ok: true };
  }, { role: 'gakudo' });

  // ---- API：運営事務局（アカウント発行） ----

  route('GET', '/api/admin/orgs', () => store.directory(), { role: 'admin' });

  route('POST', '/api/admin/orgs', ({ body }) => {
    if (body.type !== 'school' && body.type !== 'gakudo') throw new AppError('種類は学校か学童を選んでください');
    const org = store.createOrg({ type: body.type, name: body.name, municipality: body.municipality, phone: body.phone });
    store.save();
    return org;
  }, { role: 'admin' });

  route('POST', '/api/admin/users', ({ body }) => {
    const user = store.createUser({ orgId: body.orgId, loginId: body.loginId, name: body.name, password: body.password });
    store.save();
    return { id: user.id };
  }, { role: 'admin' });

  route('POST', '/api/admin/users/:id/password', ({ params, body }) => {
    store.resetPassword(params.id, body.password);
    endSessionsOf(params.id);
    store.save();
    return { ok: true };
  }, { role: 'admin' });

  route('DELETE', '/api/admin/users/:id', ({ user, params }) => {
    if (params.id === user.id) throw new AppError('自分自身は削除できません');
    store.deleteUser(params.id);
    endSessionsOf(params.id);
    store.save();
    return { ok: true };
  }, { role: 'admin' });

  // ---- API：保護者（ログイン不要。学校が配布したリンクのコードで閲覧） ----

  route('GET', '/api/public/schools/:id', ({ params, query }) =>
    store.publicSchoolMonth(params.id, query.get('code'), query.get('month') || ''), { role: 'public' });

  // ---- HTTP ハンドラ ----

  function sendJson(res, status, body) {
    res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > BODY_LIMIT) {
          reject(new AppError('リクエストが大きすぎます', 413));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new AppError('JSON の形式が正しくありません'));
        }
      });
      req.on('error', reject);
    });
  }

  function serveStatic(req, res, pathname) {
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = path.join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 404, { error: 'Not Found' });
    fs.readFile(file, (err, data) => {
      if (err) return sendJson(res, 404, { error: 'Not Found' });
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  }

  async function handle(req, res) {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method Not Allowed' });
      return serveStatic(req, res, url.pathname);
    }
    try {
      const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
      if (!r) throw new AppError('Not Found', 404);
      const m = url.pathname.match(r.re);
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));

      let body = {};
      if (req.method !== 'GET') {
        // CSRF 対策：JSON 以外の書き込みリクエストは受け付けない
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
          throw new AppError('Content-Type は application/json にしてください', 415);
        }
        body = await readBody(req);
        if (!body || typeof body !== 'object') throw new AppError('JSON の形式が正しくありません');
      }

      const user = currentUser(req);
      const org = user && store.org(user.orgId);
      if (r.role !== 'public') {
        if (!user || !org) throw new AppError('ログインしてください', 401);
        if (r.role !== 'any' && org.type !== r.role) throw new AppError('この操作は許可されていません', 403);
      }

      const result = await r.handler({ req, res, user, org, params, query: url.searchParams, body });
      if (result !== undefined) sendJson(res, 200, result);
    } catch (err) {
      if (err instanceof AppError) return sendJson(res, err.status, { error: err.message });
      console.error(err);
      sendJson(res, 500, { error: 'サーバーエラーが発生しました' });
    }
  }

  return http.createServer((req, res) => {
    handle(req, res);
  });
}

if (require.main === module) {
  const file = process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json');
  const store = Store.open(file);
  if (store.isEmpty()) {
    seed(store);
    store.save();
    console.log('デモデータを作成しました（パスワードはすべて demo1234）');
  }
  const port = Number(process.env.PORT) || 3000;
  createApp({ store }).listen(port, () => {
    console.log(`下校時刻共有システム起動: http://localhost:${port}`);
  });
}

module.exports = { createApp };
