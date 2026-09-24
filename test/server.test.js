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
  assert.equal((await gakudo('GET', '/api/council/settings')).status, 403);
  const staff = client();
  await staff('POST', '/api/login', { loginId: 'school1-staff', password: 'demo1234' });
  assert.equal((await staff('GET', '/api/manage/orgs')).status, 403); // 一般職員はアカウント管理不可
  const school = client();
  await school('POST', '/api/login', { loginId: 'school1', password: 'demo1234' });
  assert.equal((await school('GET', '/api/gakudo/releases')).status, 403);
  const orgs = (await school('GET', '/api/manage/orgs')).body;
  assert.deepEqual(orgs.map((o) => o.name), ['サンプル沼田第一小学校']); // 管理職は自校だけ
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

// 2段階認証が必須の管理者としてログインする（テスト用：コードはサーバーと同じ計算で作る）
async function loginWithMfa(call, loginId) {
  const totp = require('../lib/totp');
  let me = await call('POST', '/api/login', { loginId, password: 'demo1234' });
  assert.equal(me.body.user.mfaSetupRequired, true);
  assert.equal((await call('GET', '/api/manage/orgs')).status, 403); // 設定前は何もできない
  const { secret } = (await call('POST', '/api/mfa/setup')).body;
  me = await call('POST', '/api/mfa/enable', { code: totp.codeAt(secret, totp.currentStep()) });
  assert.equal(me.status, 200);
  return secret;
}

test('パスワード再発行で本人のログイン中セッションは切れる', async (t) => {
  const { client, store } = await start(t);
  const teacher = client();
  await teacher('POST', '/api/login', { loginId: 'school1', password: 'demo1234' });
  const boe = client();
  await loginWithMfa(boe, 'numata-boe');
  const user = store.data.users.find((u) => u.loginId === 'school1');
  assert.equal((await boe('POST', `/api/manage/users/${user.id}/password`, { password: 'newpass123' })).status, 200);
  assert.equal((await teacher('GET', '/api/me')).status, 401);
});

test('2段階認証を設定した管理者は、次回からコードがないとログインできない', async (t) => {
  const totp = require('../lib/totp');
  const { client } = await start(t);
  const secret = await loginWithMfa(client(), 'council');
  const again = client();
  const first = await again('POST', '/api/login', { loginId: 'council', password: 'demo1234' });
  assert.equal(first.body.mfa, true);
  assert.equal((await again('GET', '/api/me')).status, 401); // パスワードだけではログインできない
  assert.equal((await again('POST', '/api/login/mfa', { ticket: first.body.ticket, code: '000000' })).status, 401);
  const ok = await again('POST', '/api/login/mfa', { ticket: first.body.ticket, code: totp.codeAt(secret, totp.currentStep() + 1) });
  assert.equal(ok.status, 200);
  assert.equal((await again('GET', '/api/me')).status, 200);
});

test('市町村は他の市町村の学校を管理できない・停止したアカウントは即ログアウト', async (t) => {
  const { client, store } = await start(t);
  const boe = client();
  await loginWithMfa(boe, 'minakami-boe');
  const names = (await boe('GET', '/api/manage/orgs')).body.map((o) => o.name);
  assert.ok(names.includes('サンプルみなかみ小学校'));
  assert.ok(!names.includes('サンプル沼田第一小学校'));
  const numataTeacher = store.data.users.find((u) => u.loginId === 'school1');
  assert.equal((await boe('POST', `/api/manage/users/${numataTeacher.id}/disabled`, { disabled: true })).status, 403);

  const principal = client();
  await principal('POST', '/api/login', { loginId: 'school1', password: 'demo1234' });
  const staffCall = client();
  await staffCall('POST', '/api/login', { loginId: 'school1-staff', password: 'demo1234' });
  const staff = store.data.users.find((u) => u.loginId === 'school1-staff');
  assert.equal((await principal('POST', `/api/manage/users/${staff.id}/disabled`, { disabled: true })).status, 200);
  assert.equal((await staffCall('GET', '/api/me')).status, 401);
  assert.equal((await client()('POST', '/api/login', { loginId: 'school1-staff', password: 'demo1234' })).status, 401);
});

test('公開・承認・ログインなどが操作履歴に残る', async (t) => {
  const { client } = await start(t);
  const school = client();
  await school('POST', '/api/login', { loginId: 'school1', password: 'demo1234' });
  await school('PUT', '/api/school/entries', { days: { '2030-01-10': { grades: ['13:00'], note: '' } } });
  await school('POST', '/api/school/publish', {});
  await client()('POST', '/api/login', { loginId: 'school1', password: 'wrong' });
  const council = client();
  await loginWithMfa(council, 'council');
  const actions = (await council('GET', '/api/manage/audit')).body.map((a) => a.action);
  for (const a of ['ログイン', '下校時刻の公開', 'ログイン失敗', '2段階認証の設定']) assert.ok(actions.includes(a), a);
});

function fakeSubscription(n) {
  const ecdh = require('node:crypto').createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/device${n}`,
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: require('node:crypto').randomBytes(16).toString('base64url') },
  };
}

async function startWithPush(t, { trustProxy = false } = {}) {
  const store = new Store();
  seed(store);
  const sent = [];
  let respond = () => 'ok';
  const server = createApp({ store, trustProxy, pushSender: async (sub, payload) => { sent.push({ sub, payload }); return respond(sub); } });
  await new Promise((r) => server.listen(0, r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = (headersExtra = {}) => {
    let cookie = '';
    return async (method, url, body) => {
      const headers = { cookie, ...headersExtra };
      if (method !== 'GET') headers['Content-Type'] = 'application/json';
      const res = await fetch(base + url, { method, headers, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      return { status: res.status, body: await res.json().catch(() => null) };
    };
  };
  return { store, client, sent, setRespond: (f) => { respond = f; } };
}

const waitFor = async (cond) => {
  for (let i = 0; i < 50 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
};

test('公開すると学童と保護者にプッシュ通知が届き、無効な宛先は削除される', async (t) => {
  const { store, client, sent, setRespond } = await startWithPush(t);
  const school1 = store.data.orgs.find((o) => o.name === 'サンプル沼田第一小学校');
  const gakudo = client();
  await gakudo('POST', '/api/login', { loginId: 'gakudo1', password: 'demo1234' });
  assert.equal((await gakudo('POST', '/api/gakudo/push', { subscription: fakeSubscription(1) })).status, 200);

  const parent = client();
  const q = `code=${school1.viewCode}`;
  assert.equal((await parent('POST', `/api/public/schools/${school1.id}/push?${q}`, { subscription: fakeSubscription(2) })).status, 200);
  assert.equal((await parent('POST', `/api/public/schools/${school1.id}/push?code=wrong`, { subscription: fakeSubscription(3) })).status, 404);
  assert.equal((await parent('POST', `/api/public/schools/${school1.id}/push?${q}`, { subscription: { endpoint: 'https://evil.example.com/x', keys: fakeSubscription(4).keys } })).status, 400);

  setRespond((sub) => (sub.endpoint.endsWith('device2') ? 'gone' : 'ok'));
  const school = client();
  await school('POST', '/api/login', { loginId: 'school1', password: 'demo1234' });
  await school('PUT', '/api/school/entries', { days: { '2030-01-10': { grades: ['13:00'], note: '' } } });
  await school('POST', '/api/school/publish', { message: '' });
  await waitFor(() => sent.length >= 2);

  assert.deepEqual(sent.map((s) => s.sub.endpoint.slice(-7)).sort(), ['device1', 'device2']);
  const toParent = sent.find((s) => s.sub.endpoint.endsWith('device2')).payload;
  assert.match(toParent.title, /サンプル沼田第一小学校/);
  assert.match(toParent.url, new RegExp(`code=${school1.viewCode}`));
  await waitFor(() => store.parentPushCount(school1.id) === 0);
  assert.equal(store.parentPushCount(school1.id), 0); // 410 が返った宛先は削除
});

test('保護者リンクを作り直すと保護者の通知登録も解除される', async (t) => {
  const { store, client } = await startWithPush(t);
  const school1 = store.data.orgs.find((o) => o.name === 'サンプル沼田第一小学校');
  const parent = client();
  await parent('POST', `/api/public/schools/${school1.id}/push?code=${school1.viewCode}`, { subscription: fakeSubscription(1) });
  assert.equal(store.parentPushCount(school1.id), 1);
  const school = client();
  await school('POST', '/api/login', { loginId: 'school1', password: 'demo1234' });
  await school('POST', '/api/school/parent-link', { regenerate: true });
  assert.equal(store.parentPushCount(school1.id), 0);
});

test('ログインのロックは接続元ごと（他の場所からの先生のログインは妨げない）', async (t) => {
  const { client } = await startWithPush(t, { trustProxy: true });
  const attacker = client({ 'X-Forwarded-For': '203.0.113.9' });
  for (let i = 0; i < 5; i++) await attacker('POST', '/api/login', { loginId: 'school1', password: 'x' });
  assert.equal((await attacker('POST', '/api/login', { loginId: 'school1', password: 'demo1234' })).status, 429);
  const teacher = client({ 'X-Forwarded-For': '198.51.100.20' });
  assert.equal((await teacher('POST', '/api/login', { loginId: 'school1', password: 'demo1234' })).status, 200);
});

test('保護者ページには今後の日付の「修正」だけが最近の変更として出る', async (t) => {
  const { store, client } = await startWithPush(t);
  const school1 = store.data.orgs.find((o) => o.name === 'サンプル沼田第一小学校');
  const school = client();
  await school('POST', '/api/login', { loginId: 'school1', password: 'demo1234' });
  await school('PUT', '/api/school/entries', { days: { '2030-01-10': { grades: ['13:00'], note: '' } } });
  await school('POST', '/api/school/publish', {});
  let res = await client()('GET', `/api/public/schools/${school1.id}?code=${school1.viewCode}&month=2030-01`);
  assert.equal(res.body.updates.length, 0); // 新規公開は「変更」扱いしない
  await school('PUT', '/api/school/entries', { days: { '2030-01-10': { grades: ['12:00'], note: '' } } });
  await school('POST', '/api/school/publish', { message: '短縮' });
  res = await client()('GET', `/api/public/schools/${school1.id}?code=${school1.viewCode}&month=2030-01`);
  assert.equal(res.body.updates.length, 1);
  assert.equal(res.body.updates[0].message, '短縮');
  assert.equal(res.body.updates[0].changes[0].after, '12:00');
  assert.equal(res.body.updates[0].publishedByName, undefined); // 先生の名前は出さない
});

test('バックアップは連絡協議会だけが取得できる', async (t) => {
  const { client } = await startWithPush(t);
  const council = client();
  await loginWithMfa(council, 'council');
  const res = await council('GET', '/api/council/backup');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.orgs));
  const boe = client();
  await loginWithMfa(boe, 'numata-boe');
  assert.equal((await boe('GET', '/api/council/backup')).status, 403);
});
