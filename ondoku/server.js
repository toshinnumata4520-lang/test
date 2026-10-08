'use strict';
// 音読・発音チェック 試作品のサーバー（外部ライブラリなし）
//   起動：node ondoku/server.js   →  http://localhost:3100
//   環境変数：PORT / GEMINI_API_KEY / GEMINI_MODEL

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const passages = require('./lib/passages');
const { askGemini } = require('./lib/gemini');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 8 * 1024 * 1024; // 録音は1分程度まで
const MAX_TEXT = 1000;
const AUDIO_TYPES = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/aac'];
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': type,
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
    // マイクはこの画面自身にだけ許可する
    'permissions-policy': 'microphone=(self)',
  });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('録音が長すぎます（1分以内にしてください）'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(Object.assign(new Error('送られた内容を読み取れません'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function validateAdvice(body) {
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const audio = typeof body.audio === 'string' ? body.audio : '';
  const mimeType = String(body.mimeType || '').split(';')[0].trim().toLowerCase();
  if (!text) return '見本の英文がありません';
  if (text.length > MAX_TEXT) return `英文は${MAX_TEXT}文字以内にしてください`;
  if (!audio || !/^[A-Za-z0-9+/]+=*$/.test(audio)) return '録音がありません';
  if (!AUDIO_TYPES.includes(mimeType)) return 'この録音形式には対応していません';
  return { text, audio, mimeType };
}

function createServer(deps = {}) {
  const advise = deps.askGemini || askGemini;
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/api/passages') {
        return send(res, 200, passages);
      }
      if (req.method === 'POST' && url.pathname === '/api/advice') {
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
          return send(res, 415, { error: 'JSON で送ってください' });
        }
        const v = validateAdvice(await readJson(req));
        if (typeof v === 'string') return send(res, 400, { error: v });
        return send(res, 200, await advise(v));
      }
      if (req.method === 'GET') {
        // 照合処理はサーバーと画面で同じものを使う
        if (url.pathname === '/compare.js') {
          return send(res, 200, fs.readFileSync(path.join(__dirname, 'lib', 'compare.js')), MIME['.js']);
        }
        const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const file = path.join(PUBLIC_DIR, name);
        if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
          return send(res, 404, { error: '見つかりません' });
        }
        return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
      }
      return send(res, 404, { error: '見つかりません' });
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error('[ondoku]', e.message);
      return send(res, status, { error: status >= 500 && !e.status ? 'サーバーでエラーが起きました' : e.message });
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3100;
  createServer().listen(port, () => console.log(`音読チェック: http://localhost:${port}`));
}

module.exports = { createServer, validateAdvice };
