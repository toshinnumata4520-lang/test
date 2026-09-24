'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../lib/store');
const { seed } = require('../lib/seed');
const { createApp } = require('../server');

async function start(t) {
  const store = new Store();
  seed(store);
  const server = createApp({ store });
  await new Promise((r) => server.listen(0, r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  function client() {
    let cookie = '';
    return async (method, url, body) => {
      const headers = { cookie };
      if (method !== 'GET') headers['Content-Type'] = 'application/json';
      const res = await fetch(base + url, { method, headers, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
    };
  }
  return { store, base, client };
}

test('ログインしないと API は使えない', async (t) => {
  const { client } = await start(t);
  const call = client();
  assert.equal((await call('GET', '/api/me')).status, 401);
  assert.equal((await call('POST', '/api/login', { loginId: 'school1', password: 'wrong' })).status, 401);
  assert.equal((await call('POST', '/api/login', { loginId: 'school1', password: 'demo1234' })).status, 200);
  assert.equal((await call('GET', '/api/me')).body.org.type, 'school');
});

test('ログインに5回失敗するとロックされる', async (t) => {
  const { client } = await start(t);
  const call = client();
  for (let i = 0; i < 5; i++) await call('POST', '/api/login', { loginId: 'school1', password: 'x' });
  const locked = await call('POST', '/api/login', { loginId: 'school1', password: 'demo1234' });
  assert.equal(locked.status, 429);
});

test('役割ごとにできる操作が分かれている', async (t) => {
  const { client } = await start(t);
  const gakudo = client();
  await gakudo('POST', '/api/login', { loginId: 'gakudo1', password: 'demo1234' });
  assert.equal((await gakudo('POST', '/api/school/publish', {})).status, 403);
  assert.equal((await gakudo('GET', '/api/admin/orgs')).status, 403);
  const school = client();
  await school('POST', '/api/login', { loginId: 'school1', password: 'demo1234' });
  assert.equal((await school('GET', '/api/gakudo/releases')).status, 403);
});

test('JSON 以外の書き込みは拒否（CSRF 対策）', async (t) => {
  const { base } = await start(t);
  const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'loginId=school1&password=demo1234' });
  assert.equal(res.status, 415);
});

test('検索エンジン除外・埋め込み禁止のヘッダが付く', async (t) => {
  const { base } = await start(t);
  const res = await fetch(`${base}/`);
  assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.ok(res.headers.get('content-security-policy'));
});

test('公開 → 学童に届く → 確認 → 学校に確認済みと出る', async (t) => {
  const { client, store } = await start(t);
  const school = client();
  await school('POST', '/api/login', { loginId: 'school1', password: 'demo1234' });
  const gakudo = client();
  await gakudo('POST', '/api/login', { loginId: 'gakudo1', password: 'demo1234' });

  const before = (await gakudo('GET', '/api/gakudo/releases')).body.length;
  const put = await school('PUT', '/api/school/entries', { days: { '2030-01-10': { grades: ['13:00', '13:00', '13:00', '13:00', '13:00', '13:00'], note: '短縮日課' } } });
  assert.equal(put.status, 200);
  assert.equal(put.body.pending.changes.length, 7);

  const pub = await school('POST', '/api/school/publish', { message: 'テスト' });
  assert.equal(pub.status, 200);
  const releases = (await gakudo('GET', '/api/gakudo/releases')).body;
  assert.equal(releases.length, before + 1);
  assert.equal(releases[0].message, 'テスト');

  assert.equal((await gakudo('POST', `/api/gakudo/releases/${releases[0].id}/ack`)).status, 200);
  const mine = (await school('GET', '/api/school/releases')).body[0];
  const gakudo1 = store.data.orgs.find((o) => o.name === 'サンプル学習塾 学童クラブ');
  assert.ok(mine.acks.find((a) => a.gakudoId === gakudo1.id).ackedAt);
});

test('学童の受信申請は学校が承認するまで何も見えない', async (t) => {
  const { client, store } = await start(t);
  const gakudo = client();
  await gakudo('POST', '/api/login', { loginId: 'gakudo3', password: 'demo1234' });
  const school1 = store.data.orgs.find((o) => o.name === 'サンプル沼田第一小学校');
  const sched = (await gakudo('GET', '/api/gakudo/schedule?from=2000-01-01&to=2100-12-31')).body;
  assert.ok(!sched.some((s) => s.id === school1.id)); // 承認待ち

  const school = client();
  await school('POST', '/api/login', { loginId: 'school1', password: 'demo1234' });
  const link = (await school('GET', '/api/school/links')).body.find((l) => l.status === 'pending');
  await school('POST', `/api/school/links/${link.id}`, { approve: true });
  const after = (await gakudo('GET', '/api/gakudo/schedule?from=2000-01-01&to=2100-12-31')).body;
  assert.ok(after.some((s) => s.id === school1.id));
});

test('保護者ページはコードがないと見られない', async (t) => {
  const { client, store } = await start(t);
  const call = client();
  const school1 = store.data.orgs.find((o) => o.name === 'サンプル沼田第一小学校');
  assert.equal((await call('GET', `/api/public/schools/${school1.id}?month=2026-10`)).status, 404);
  assert.equal((await call('GET', `/api/public/schools/${school1.id}?code=${school1.viewCode}&month=2026-10`)).status, 200);
});

test('パスワード再発行で本人のログイン中セッションは切れる', async (t) => {
  const { client, store } = await start(t);
  const teacher = client();
  await teacher('POST', '/api/login', { loginId: 'school1', password: 'demo1234' });
  const admin = client();
  await admin('POST', '/api/login', { loginId: 'admin', password: 'demo1234' });
  const user = store.data.users.find((u) => u.loginId === 'school1');
  assert.equal((await admin('POST', `/api/admin/users/${user.id}/password`, { password: 'newpass123' })).status, 200);
  assert.equal((await teacher('GET', '/api/me')).status, 401);
});
