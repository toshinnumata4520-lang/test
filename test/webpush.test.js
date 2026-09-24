'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { generateVapidKeys, validateSubscription, encrypt, vapidAuthorization, sendPush } = require('../lib/webpush');

// ブラウザ側の役割（受信者）を再現して、暗号文を復号できるか確かめる
function makeBrowser() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return {
    ecdh,
    auth,
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') },
  };
}

function decrypt(body, browser) {
  const salt = body.subarray(0, 16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const data = body.subarray(21 + idlen);
  const shared = browser.ecdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), browser.ecdh.getPublicKey(), asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, browser.auth, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(data.subarray(data.length - 16));
  const plain = Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
  assert.equal(plain[plain.length - 1], 2);
  return plain.subarray(0, plain.length - 1).toString();
}

test('暗号化した通知をブラウザ側の鍵で復号できる', () => {
  const browser = makeBrowser();
  const payload = JSON.stringify({ title: 'テスト', body: '10/3(金) 3年 15:35→13:30' });
  assert.equal(decrypt(encrypt(payload, browser.keys), browser), payload);
});

test('VAPID の署名を公開鍵で検証できる', () => {
  const vapid = generateVapidKeys();
  const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', vapid, 'mailto:a@example.com');
  const [, jwt, k] = header.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(k, vapid.publicKey);
  const [h, c, sig] = jwt.split('.');
  const claims = JSON.parse(Buffer.from(c, 'base64url'));
  assert.equal(claims.aud, 'https://fcm.googleapis.com');
  const raw = Buffer.from(vapid.publicKey, 'base64url');
  const pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
});

test('既知のプッシュサービス以外の宛先は受け付けない', () => {
  const { keys } = makeBrowser();
  assert.ok(validateSubscription({ endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys }));
  assert.ok(validateSubscription({ endpoint: 'https://web.push.apple.com/abc', keys }));
  assert.equal(validateSubscription({ endpoint: 'https://evil.example.com/x', keys }), null);
  assert.equal(validateSubscription({ endpoint: 'http://fcm.googleapis.com/x', keys }), null);
  assert.equal(validateSubscription({ endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'abc', auth: 'def' } }), null);
});

test('送信：410 は「削除すべき購読」として返す', async () => {
  const vapid = generateVapidKeys();
  const { keys } = makeBrowser();
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys };
  let seen;
  const ok = await sendPush(sub, { title: 't' }, { vapid, subject: 'mailto:a@example.com', urgent: true, fetchImpl: async (url, opts) => { seen = opts; return { status: 201, ok: true }; } });
  assert.equal(ok, 'ok');
  assert.equal(seen.headers.Urgency, 'high');
  assert.equal(seen.headers['Content-Encoding'], 'aes128gcm');
  const gone = await sendPush(sub, { title: 't' }, { vapid, subject: 'x', fetchImpl: async () => ({ status: 410, ok: false }) });
  assert.equal(gone, 'gone');
});
