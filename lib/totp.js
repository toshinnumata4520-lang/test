'use strict';

// 2段階認証（ワンタイムパスワード、RFC 6238 TOTP）。
// Google Authenticator・Microsoft Authenticator などのスマホアプリで 6 桁のコードを表示する方式。

const crypto = require('node:crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(s) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const c of s.replace(/[\s=-]/g, '').toUpperCase()) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error('invalid base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function codeAt(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 15;
  const bin = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(bin % 1e6).padStart(6, '0');
}

function currentStep(now = Date.now()) {
  return Math.floor(now / 1000 / STEP_SECONDS);
}

// 時計のずれを考慮して前後 1 ステップ（±30 秒）まで受け付ける。
// 一致したステップを返す（同じコードの使い回しを防ぐため、呼び出し側で記録する）。一致しなければ null
function verify(secret, code, { now = Date.now(), lastStep = -1 } = {}) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const step = currentStep(now);
  for (const s of [step - 1, step, step + 1]) {
    if (s <= lastStep) continue;
    const expected = codeAt(secret, s);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(c))) return s;
  }
  return null;
}

function otpauthUri(secret, account, issuer = 'ToneNumata-Gekou') {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;
}

module.exports = { generateSecret, verify, codeAt, currentStep, otpauthUri, base32Encode, base32Decode };
