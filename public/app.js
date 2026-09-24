'use strict';

// 利根沼田 下校時刻共有システム 画面側
// 学校・学童・運営事務局・保護者の 4 種類の画面をこの 1 ファイルで切り替える。

const GRADES = 6;
const DOW = ['日', '月', '火', '水', '木', '金', '土'];

const appEl = document.getElementById('app');
const accountEl = document.getElementById('account');
const dialogEl = document.getElementById('dialog');

const state = { me: null, tab: null, month: null, date: null, entries: {}, pending: null };

// ---------------------------------------------------------------- 共通部品

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

async function api(method, url, body) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (method !== 'GET') {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body ?? {});
  }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `エラーが発生しました (${res.status})`);
    err.status = res.status;
    if (res.status === 401 && state.me) location.reload();
    throw err;
  }
  return data;
}

function toast(message, { alert = false } = {}) {
  const el = document.createElement('div');
  el.className = `toast${alert ? ' alert-toast' : ''}`;
  el.textContent = message;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), alert ? 10000 : 4000);
}

function desktopNotify(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    new Notification(title, { body });
  } catch {
    /* 一部のブラウザでは使えない */
  }
}

// ---- プッシュ通知（画面を閉じていても届く） ----

const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent);

function b64ToBytes(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

async function currentPushSubscription() {
  if (!pushSupported() || Notification.permission !== 'granted') return null;
  const reg = await navigator.serviceWorker.register('/sw.js');
  return reg.pushManager.getSubscription();
}

async function enablePush(saveUrl) {
  if (!pushSupported()) {
    throw new Error(isIos()
      ? 'iPhone・iPad では、Safari の共有ボタンから「ホーム画面に追加」をして、追加したアイコンから開くと通知を受け取れます'
      : 'このブラウザは通知に対応していません。Chrome・Edge・Safari などの最新版でお試しください');
  }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('通知が許可されませんでした。ブラウザの設定でこのサイトの通知を許可してください');
  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    const { publicKey } = await api('GET', '/api/push/key');
    try {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
    } catch (err) {
      throw new Error(`通知の登録に失敗しました。ブラウザの設定でこのサイトの通知が許可されているか確認してください（${err.message}）`);
    }
  }
  await api('POST', saveUrl, { subscription: sub.toJSON() });
}

// ブラウザ側の登録は残し（他の学校・学童の通知に使っている場合があるため）、この登録先だけ解除する
async function disablePush(url) {
  const sub = await currentPushSubscription();
  if (sub) await api('DELETE', url, { endpoint: sub.endpoint });
}

function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* 保存できない環境では毎回確認する */
  }
}

function withErrors(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      toast(err.message, { alert: true });
    }
  };
}

function openDialog(html) {
  dialogEl.innerHTML = html;
  dialogEl.showModal();
  dialogEl.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => dialogEl.close()));
  return dialogEl;
}

// ---- 日付 ----

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseDate = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const todayStr = () => ymd(new Date());
const addDays = (s, n) => {
  const d = parseDate(s);
  d.setDate(d.getDate() + n);
  return ymd(d);
};
const dowOf = (s) => parseDate(s).getDay();
const fmtDate = (s) => {
  const d = parseDate(s);
  return `${d.getMonth() + 1}/${d.getDate()}(${DOW[d.getDay()]})`;
};
const fmtMonth = (m) => `${m.slice(0, 4)}年${Number(m.slice(5))}月`;
const fmtDateTime = (iso) => {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
function shiftMonth(m, n) {
  const d = new Date(Number(m.slice(0, 4)), Number(m.slice(5)) - 1 + n, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}
function monthDates(m) {
  const last = new Date(Number(m.slice(0, 4)), Number(m.slice(5)), 0).getDate();
  return Array.from({ length: last }, (_, i) => `${m}-${pad(i + 1)}`);
}
function weekDates(s) {
  const monday = addDays(s, -((dowOf(s) + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

// ---- 表示部品 ----

const emptyDay = () => ({ grades: Array(GRADES).fill(''), note: '' });
const timeText = (t) => t || '―';

function describeChange(c) {
  const before = c.before || '（未設定）';
  const after = c.after || '（なし）';
  const what = c.field === 'note' ? '備考' : `${c.grade}年`;
  return `<li><b>${esc(fmtDate(c.date))}</b> ${what}：${esc(before)}<span class="arrow">→</span><span class="after">${esc(after)}</span></li>`;
}

function changesHtml(changes, limit = 12) {
  if (changes.length <= limit) return `<ul class="changes">${changes.map(describeChange).join('')}</ul>`;
  return `<ul class="changes">${changes.slice(0, limit).map(describeChange).join('')}</ul>
    <details><summary>残り ${changes.length - limit} 件を表示</summary><ul class="changes">${changes.slice(limit).map(describeChange).join('')}</ul></details>`;
}

function releaseTags(r) {
  return `${r.kind === 'revision' ? '<span class="tag revision">修正</span>' : '<span class="tag new">新規公開</span>'}
    ${r.urgent ? `<span class="tag urgent">当日・翌日の変更（${r.urgentDates.map(fmtDate).join('、')}）</span>` : ''}`;
}

function tabsHtml(tabs) {
  return `<nav class="tabs no-print">${tabs
    .map(([id, label, badge]) =>
      `<button class="tab${state.tab === id ? ' active' : ''}" data-tab="${id}">${esc(label)}${badge ? `<span class="badge">${badge}</span>` : ''}</button>`)
    .join('')}</nav>`;
}

function bindTabs(render) {
  appEl.querySelectorAll('[data-tab]').forEach((b) =>
    b.addEventListener('click', () => {
      state.tab = b.dataset.tab;
      render();
    }));
}

// ---------------------------------------------------------------- 起動・ログイン

async function boot() {
  const params = new URLSearchParams(location.search);
  if (params.get('view') === 'parent') return renderParent(params);
  try {
    state.me = await api('GET', '/api/me');
  } catch {
    return renderLogin();
  }
  renderAccount();
  if (state.me.user.mfaSetupRequired) return renderMfaSetup(); // 管理者は2段階認証の設定が済むまで他の操作をさせない
  startEvents();
  const type = state.me.org.type;
  if (type === 'school') {
    state.tab = 'input';
    state.month = todayStr().slice(0, 7);
    renderSchool();
  } else if (type === 'gakudo') {
    state.tab = 'today';
    state.date = todayStr();
    await syncGakudoPush();
    renderGakudo();
  } else {
    state.tab = 'orgs';
    renderManage();
  }
}

function renderLogin() {
  accountEl.innerHTML = '';
  const demo = [
    ['school1', '学校・管理職（沼田第一小 教頭）'],
    ['school1-staff', '学校・職員（沼田第一小 教務）'],
    ['school2', '学校（沼田第二小）'],
    ['gakudo1', '学童（学習塾 学童クラブ）'],
    ['gakudo3', '学童（みなかみ学童）'],
    ['numata-boe', '沼田市教育委員会'],
    ['numata-kodomo', '沼田市 学童担当課'],
    ['council', '連絡協議会 事務局'],
  ];
  appEl.innerHTML = `
    <div class="card login">
      <h1>ログイン</h1>
      <p class="muted">学校・学童の職員の方は、各市町村（教育委員会等）または所属先の管理職から発行されたIDでログインしてください。<br>保護者の方は、学校から配布されたリンクから閲覧できます（ログイン不要）。</p>
      <form id="login-form">
        <label for="loginId">ログインID</label>
        <input id="loginId" autocomplete="username" required>
        <label for="password">パスワード</label>
        <input id="password" type="password" autocomplete="current-password" required>
        <p class="error" id="login-error"></p>
        <button class="btn primary" type="submit">ログイン</button>
      </form>
      <hr>
      <div class="demo-accounts">
        <p class="muted">デモ用アカウント（パスワードはすべて <code>demo1234</code>）<br>教育委員会・協議会は最初に2段階認証の設定を求められます。</p>
        ${demo.map(([id, label]) => `<button class="btn small" data-demo="${id}">${esc(label)}</button>`).join('')}
      </div>
      <p class="muted"><a href="/terms.html">利用規約・プライバシーポリシー（案）</a></p>
    </div>`;
  const form = document.getElementById('login-form');
  appEl.querySelectorAll('[data-demo]').forEach((b) =>
    b.addEventListener('click', () => {
      form.loginId.value = b.dataset.demo;
      form.password.value = 'demo1234';
      form.requestSubmit();
    }));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await api('POST', '/api/login', { loginId: form.loginId.value.trim(), password: form.password.value });
      if (r.mfa) return renderMfaLogin(r.ticket);
      location.reload();
    } catch (err) {
      document.getElementById('login-error').textContent = err.message;
    }
  });
}

// パスワードの次に、スマホの認証アプリの6桁コードを入れる
function renderMfaLogin(ticket) {
  appEl.innerHTML = `
    <div class="card login">
      <h1>2段階認証</h1>
      <p>スマホの認証アプリ（Google Authenticator など）に表示されている<b>6桁の数字</b>を入力してください。</p>
      <form id="mfa-form">
        <input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" required placeholder="123456" class="code-input">
        <p class="error" id="mfa-error"></p>
        <button class="btn primary">ログイン</button>
        <a class="btn" href="/">やり直す</a>
      </form>
      <p class="muted">スマホをなくした・機種変更した場合は、所属先の管理者（教育委員会など）に2段階認証の解除を依頼してください。</p>
    </div>`;
  const form = appEl.querySelector('#mfa-form');
  form.code.focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/api/login/mfa', { ticket, code: form.code.value.replace(/\s/g, '') });
      location.reload();
    } catch (err) {
      appEl.querySelector('#mfa-error').textContent = err.message;
      if (err.status === 401 && /時間切れ/.test(err.message)) setTimeout(() => location.reload(), 1500);
    }
  });
}

function mfaSetupHtml(setup) {
  const key = setup.secret.replace(/(.{4})/g, '$1 ').trim();
  return `
    <ol class="mfa-steps">
      <li>スマホに認証アプリを入れます（<b>Google Authenticator</b> または <b>Microsoft Authenticator</b>。どちらも無料）。</li>
      <li>アプリで「＋」→「<b>セットアップキーを入力</b>」を選び、次のとおり入力します。
        <dl class="mfa-key">
          <dt>アカウント名</dt><dd>${esc(state.me.user.loginId)}（何でも構いません）</dd>
          <dt>キー</dt><dd><code>${esc(key)}</code></dd>
          <dt>種類</dt><dd>時間ベース</dd>
        </dl>
        <p class="muted">この画面をスマホで開いている場合は <a href="${esc(setup.uri)}">ここを押すとアプリに登録</a>できます。</p>
      </li>
      <li>アプリに表示された<b>6桁の数字</b>を下に入力して「設定する」を押します。</li>
    </ol>
    <form id="mfa-enable-form" class="row">
      <input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" required placeholder="123456" class="code-input">
      <button class="btn primary">設定する</button>
    </form>`;
}

async function bindMfaSetup(root, onDone) {
  root.querySelector('#mfa-enable-form').addEventListener('submit', withErrors(async (e) => {
    e.preventDefault();
    state.me = await api('POST', '/api/mfa/enable', { code: e.target.code.value.replace(/\s/g, '') });
    toast('2段階認証を設定しました。次回からログイン時に6桁の数字が必要です');
    onDone();
  }));
}

// 管理者（協議会・市町村など）は最初のログインで必ず設定する
async function renderMfaSetup() {
  const setup = await api('POST', '/api/mfa/setup');
  appEl.innerHTML = `
    <div class="card mfa-card">
      <h1>2段階認証の設定（必須）</h1>
      <p>この役割のアカウントは、パスワードが漏れても不正にログインされないよう、<b>2段階認証が必須</b>です。設定は最初の1回だけ、3分ほどで終わります。</p>
      ${mfaSetupHtml(setup)}
    </div>`;
  bindMfaSetup(appEl, () => location.reload());
}

function renderAccount() {
  const { user, org } = state.me;
  accountEl.innerHTML = `
    <span>${esc(org.name)}<br><small>${esc(user.name)}${user.role === 'manager' ? '（管理者）' : ''}</small></span>
    ${!user.mfaEnabled && !user.mfaSetupRequired ? '<button class="btn small" id="mfa-btn">2段階認証を設定</button>' : ''}
    <button class="btn small" id="pw-btn">パスワード変更</button>
    <button class="btn small" id="logout-btn">ログアウト</button>`;
  const mfaBtn = document.getElementById('mfa-btn');
  if (mfaBtn) mfaBtn.addEventListener('click', withErrors(async () => {
    const setup = await api('POST', '/api/mfa/setup');
    const dlg = openDialog(`<div class="dialog-body"><h2>2段階認証の設定</h2>
      <p>設定すると、ログイン時にパスワードに加えてスマホの6桁の数字が必要になり、安全性が高まります。</p>${mfaSetupHtml(setup)}</div>
      <div class="dialog-actions"><button type="button" class="btn" data-close>閉じる</button></div>`);
    bindMfaSetup(dlg, () => {
      dlg.close();
      renderAccount();
    });
  }));
  document.getElementById('logout-btn').addEventListener('click', async () => {
    await api('POST', '/api/logout');
    location.href = '/';
  });
  document.getElementById('pw-btn').addEventListener('click', () => {
    const dlg = openDialog(`
      <form class="dialog-form" id="pw-form">
        <div class="dialog-body">
          <h2>パスワード変更</h2>
          <label>現在のパスワード<input type="password" name="current" required autocomplete="current-password"></label>
          <label>新しいパスワード（8文字以上）<input type="password" name="next" required minlength="8" autocomplete="new-password"></label>
          <label>新しいパスワード（確認）<input type="password" name="confirm" required minlength="8" autocomplete="new-password"></label>
        </div>
        <div class="dialog-actions"><button type="button" class="btn" data-close>キャンセル</button><button class="btn primary">変更する</button></div>
      </form>`);
    dlg.querySelector('#pw-form').addEventListener('submit', withErrors(async (e) => {
      e.preventDefault();
      const f = e.target;
      if (f.next.value !== f.confirm.value) throw new Error('確認用のパスワードが一致しません');
      await api('POST', '/api/password', { current: f.current.value, next: f.next.value });
      dlg.close();
      toast('パスワードを変更しました');
    }));
  });
}

async function syncGakudoPush() {
  // 以前に通知をオンにしたブラウザなら、登録をサーバーに送り直しておく
  try {
    const sub = await currentPushSubscription();
    state.pushOn = Boolean(sub && storageGet('gakudo-push') === state.me.org.id);
    if (state.pushOn) await api('POST', '/api/gakudo/push', { subscription: sub.toJSON() });
  } catch {
    state.pushOn = false;
  }
}

function pushBarHtml() {
  if (state.pushOn) return '';
  return `<div class="card notice no-print row"><span>🔔 <b>画面を閉じていても、変更があればこのパソコン・スマホに通知</b>できます。</span><span class="spacer"></span>
    <button class="btn primary small" id="push-on">通知をオンにする</button></div>`;
}

function bindPushBar() {
  const btn = appEl.querySelector('#push-on');
  if (btn) btn.addEventListener('click', withErrors(async () => {
    await enablePush('/api/gakudo/push');
    storageSet('gakudo-push', state.me.org.id);
    state.pushOn = true;
    toast('通知をオンにしました');
    renderGakudo();
  }));
}

// ---- リアルタイム通知 ----

function startEvents() {
  const es = new EventSource('/api/events');
  es.addEventListener('release', (e) => {
    const r = JSON.parse(e.data);
    const title = `${r.schoolName}が下校時刻を${r.kind === 'revision' ? '修正' : '公開'}しました`;
    const detail = r.urgent ? `【当日・翌日の変更】${r.urgentDates.map(fmtDate).join('、')}` : `${r.changes.length}件の変更`;
    toast(`${title}（${detail}）`, { alert: r.urgent || r.kind === 'revision' });
    if (!state.pushOn) desktopNotify(title, detail); // プッシュ通知がオンなら二重に出さない
    renderGakudo();
  });
  es.addEventListener('link', (e) => {
    const { status } = JSON.parse(e.data);
    toast(status === 'approved' ? '学校が受信申請を承認しました' : '学校が受信申請を承認しませんでした');
    renderGakudo();
  });
  es.addEventListener('ack', () => {
    if (state.tab === 'releases') renderSchool();
  });
  es.addEventListener('link-request', () => {
    toast('学童から受信申請が届きました');
    renderSchool();
  });
}

// ---------------------------------------------------------------- 学校

async function renderSchool() {
  const links = await api('GET', '/api/school/links');
  const pendingLinks = links.filter((l) => l.status === 'pending').length;
  const body = document.createElement('div');
  appEl.innerHTML = tabsHtml([
    ['input', '下校時刻の入力・公開'],
    ['releases', '公開履歴・確認状況'],
    ['links', '学童からの受信申請', pendingLinks],
    ['parent', '保護者向けリンク'],
    ...adminTabs(),
  ]);
  appEl.appendChild(body);
  bindTabs(renderSchool);
  if (await renderAdminTab(body)) return;
  if (state.tab === 'input') await renderSchoolInput(body, links);
  if (state.tab === 'releases') await renderSchoolReleases(body);
  if (state.tab === 'links') renderSchoolLinks(body, links);
  if (state.tab === 'parent') await renderSchoolParent(body);
}

function currentDay(date) {
  const e = state.entries[date];
  return e ? e.draft || e.published || emptyDay() : emptyDay();
}

async function renderSchoolInput(el, links) {
  const data = await api('GET', `/api/school/month?month=${state.month}`);
  state.entries = data.entries;
  state.pending = data.pending;
  const approved = links.filter((l) => l.status === 'approved').length;
  const today = todayStr();

  el.innerHTML = `
    <details class="card help">
      <summary><b>使い方</b>（はじめての方へ）</summary>
      <ol>
        <li>下の表に学年ごとの下校時刻を入力します（「1445」と数字だけ打てば 14:45 になります）。入力した内容は自動で<b>下書き保存</b>されます（まだ誰にも届きません）。</li>
        <li>毎月同じパターンなら「曜日ごとにまとめて入力」、Excelで作った下校時刻表があれば「Excelから貼り付け」が便利です。</li>
        <li>黄色の「公開する」ボタンを押すと、変更点の一覧が表示されます。確認してから公開すると、承認済みの学童（現在 ${approved} か所）に通知されます。</li>
        <li>公開後に変更があれば、表を直して再度公開するだけです。学童には「修正」として変更箇所だけが届きます。</li>
        <li>学童が内容を確認したかどうかは「公開履歴・確認状況」で分かります。</li>
      </ol>
      <p class="muted">児童の氏名などの個人情報は入力しません。扱うのは学年ごとの下校時刻と備考だけです。</p>
    </details>

    <div class="row month-nav">
      <button class="btn" id="prev-month">◀ 前の月</button>
      <h1>${fmtMonth(state.month)}</h1>
      <button class="btn" id="next-month">次の月 ▶</button>
      <span class="spacer"></span>
      <button class="btn no-print" id="print-btn">印刷（配布用）</button>
    </div>

    <div id="pending-bar"></div>

    <div class="row tools no-print">
      <details class="card tool">
        <summary><b>曜日ごとにまとめて入力</b></summary>
        <p class="muted">選んだ曜日すべてに、同じ下校時刻を下書きとして入れます。</p>
        <div class="row">${[1, 2, 3, 4, 5, 6, 0].map((d) => `<label class="chk"><input type="checkbox" name="bulk-dow" value="${d}" ${d >= 1 && d <= 5 ? 'checked' : ''}>${DOW[d]}</label>`).join('')}</div>
        <div class="bulk">${Array.from({ length: GRADES }, (_, i) => `<label>${i + 1}年<input name="bulk-g" inputmode="numeric" maxlength="6" placeholder="例 1445"></label>`).join('')}</div>
        <label class="chk"><input type="checkbox" id="bulk-overwrite">入力済みの日も上書きする</label>
        <div class="row"><button class="btn primary" id="bulk-apply">${fmtMonth(state.month)}に入力する</button></div>
      </details>
      <details class="card tool">
        <summary><b>Excelから貼り付け</b></summary>
        <p class="muted">Excelの下校時刻表で「日付・1年〜6年・備考」の範囲をコピーして貼り付けてください。日付は「10/3」「2026/10/3」「3」などの形式に対応しています。</p>
        <textarea id="paste-area" rows="5" placeholder="10/1	14:45	14:45	15:35	15:35	15:35	15:35&#10;10/2	14:45	14:45	15:35	15:35	15:35	15:35	授業参観"></textarea>
        <div class="row"><button class="btn primary" id="paste-apply">読み込む</button><span class="muted" id="paste-result"></span></div>
      </details>
    </div>

    <div class="table-wrap">
      <table class="grid" id="month-grid">
        <thead><tr><th>日付</th>${Array.from({ length: GRADES }, (_, i) => `<th>${i + 1}年</th>`).join('')}<th>備考（行事・短縮など）</th><th class="no-print">状態</th><th class="no-print"></th></tr></thead>
        <tbody>${monthDates(state.month).map((date) => schoolRowHtml(date, today)).join('')}</tbody>
      </table>
    </div>`;

  renderPendingBar();

  el.querySelector('#prev-month').addEventListener('click', () => { state.month = shiftMonth(state.month, -1); renderSchool(); });
  el.querySelector('#next-month').addEventListener('click', () => { state.month = shiftMonth(state.month, 1); renderSchool(); });
  el.querySelector('#print-btn').addEventListener('click', () => {
    if (state.pending.changes.length && !confirm('未公開の変更があります。このまま印刷すると、まだ公開していない内容も印刷されます。よろしいですか？')) return;
    window.print();
  });

  const grid = el.querySelector('#month-grid');
  grid.addEventListener('change', withErrors(async (e) => {
    const tr = e.target.closest('tr[data-date]');
    if (tr) await saveRows([tr.dataset.date], { [tr.dataset.date]: readRow(tr) });
  }));
  grid.addEventListener('click', withErrors(async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const tr = btn.closest('tr');
    const date = tr.dataset.date;
    const day = readRow(tr);
    if (btn.dataset.act === 'fill') {
      const first = day.grades.find((g) => g);
      if (!first) throw new Error('先にどれか1つの学年に時刻を入力してください');
      day.grades = day.grades.map(() => first);
    } else if (btn.dataset.act === 'clear') {
      day.grades = Array(GRADES).fill('');
    } else if (btn.dataset.act === 'revert') {
      const pub = (state.entries[date] || {}).published;
      Object.assign(day, pub ? { grades: [...pub.grades], note: pub.note } : emptyDay());
    }
    await saveRows([date], { [date]: day });
  }));

  el.querySelector('#bulk-apply').addEventListener('click', withErrors(async () => {
    const dows = [...el.querySelectorAll('[name=bulk-dow]:checked')].map((c) => Number(c.value));
    const grades = [...el.querySelectorAll('[name=bulk-g]')].map((i) => readTime(i));
    if (!dows.length) throw new Error('曜日を選んでください');
    if (!grades.some((g) => g)) throw new Error('時刻を入力してください');
    const overwrite = el.querySelector('#bulk-overwrite').checked;
    const days = {};
    for (const date of monthDates(state.month)) {
      if (!dows.includes(dowOf(date))) continue;
      const cur = currentDay(date);
      if (!overwrite && cur.grades.some((g) => g)) continue;
      days[date] = { grades: grades.map((g, i) => g || cur.grades[i]), note: cur.note };
    }
    if (!Object.keys(days).length) throw new Error('入力できる日がありません（すべて入力済みです）');
    await saveRows(Object.keys(days), days);
    toast(`${Object.keys(days).length}日分を下書きに入力しました。確認して公開してください`);
  }));

  el.querySelector('#paste-apply').addEventListener('click', withErrors(async () => {
    const { days, skipped } = parsePasted(el.querySelector('#paste-area').value, state.month);
    const dates = Object.keys(days);
    if (!dates.length) throw new Error('読み込める行がありませんでした。日付と時刻の形式を確認してください');
    await saveRows(dates, days);
    el.querySelector('#paste-result').textContent = `${dates.length}日分を下書きに入力しました${skipped.length ? `（読み込めなかった行：${skipped.length}行）` : ''}`;
  }));
}

function schoolRowHtml(date, today) {
  const entry = state.entries[date] || {};
  const day = currentDay(date);
  const pub = entry.published || emptyDay();
  const dow = dowOf(date);
  const cls = [
    dow === 0 ? 'sun weekend' : dow === 6 ? 'sat weekend' : '',
    entry.draft ? 'is-draft' : '',
    date === today ? 'is-today' : '',
  ].join(' ');
  const status = entry.draft
    ? `<span class="tag draft">未公開の変更</span>`
    : entry.published
      ? `<span class="tag ok">公開済</span>${entry.published.version > 1 ? `<small class="muted"> 第${entry.published.version}版</small>` : ''}`
      : '';
  return `<tr data-date="${date}" class="${cls}">
    <td class="date">${esc(fmtDate(date))}</td>
    ${day.grades.map((g, i) => `<td><input class="time-in${entry.draft && g !== pub.grades[i] ? ' changed' : ''}" inputmode="numeric" maxlength="6" placeholder="--:--" aria-label="${fmtDate(date)} ${i + 1}年" value="${esc(g)}"><span class="print-only">${esc(g)}</span></td>`).join('')}
    <td><input class="note${entry.draft && day.note !== pub.note ? ' changed' : ''}" maxlength="200" value="${esc(day.note)}" aria-label="${fmtDate(date)} 備考"><span class="print-only">${esc(day.note)}</span></td>
    <td class="no-print">${status}</td>
    <td class="no-print row-actions">
      <button class="btn small" data-act="fill" title="最初に入力された時刻を全学年にコピー">全学年同じ</button>
      <button class="btn small" data-act="clear" title="この日の時刻を消す（休業日など）">クリア</button>
      ${entry.draft && entry.published ? '<button class="btn small" data-act="revert" title="公開中の内容に戻す">元に戻す</button>' : ''}
    </td>
  </tr>`;
}

function readRow(tr) {
  return {
    grades: [...tr.querySelectorAll('input.time-in')].map((input) => readTime(input, fmtDate(tr.dataset.date))),
    note: tr.querySelector('input.note').value,
  };
}

// 「1445」「14:45」「14時45分」「１４：４５」などを 'HH:MM' にそろえる。読めなければエラー
function normalizeTime(s) {
  const z = String(s).trim().replace(/[０-９：]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  if (/^\d{3,4}$/.test(z)) return parsePastedTime(`${z.slice(0, -2)}:${z.slice(-2)}`);
  return parsePastedTime(z);
}

function readTime(input, label) {
  const t = normalizeTime(input.value);
  input.classList.toggle('invalid', t === null);
  if (t === null) {
    input.focus();
    throw new Error(`${label ? `${label} ` : ''}「${input.value}」は時刻として読めません。「14:45」または「1445」のように入力してください`);
  }
  input.value = t;
  return t;
}

async function saveRows(dates, days) {
  const { pending } = await api('PUT', '/api/school/entries', { days });
  state.pending = pending;
  // 表示中の月のデータを取り直して行を描き直す
  const data = await api('GET', `/api/school/month?month=${state.month}`);
  state.entries = data.entries;
  const today = todayStr();
  for (const date of dates) {
    const tr = appEl.querySelector(`tr[data-date="${date}"]`);
    if (tr) tr.outerHTML = schoolRowHtml(date, today);
  }
  renderPendingBar();
}

// Excel などからコピーした表（タブ区切り・カンマ区切り）を読み取る
function parsePasted(text, month) {
  const days = {};
  const skipped = [];
  const [y, m] = month.split('-').map(Number);
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const cells = line.split(/\t|,/).map((c) => c.trim());
    const date = parsePastedDate(cells[0], y, m);
    if (!date) {
      skipped.push(line);
      continue;
    }
    const times = [];
    let note = '';
    for (const c of cells.slice(1)) {
      const t = parsePastedTime(c);
      if (times.length < GRADES && (t !== null)) times.push(t);
      else if (c) note = note ? `${note} ${c}` : c;
    }
    if (!times.some((t) => t) && !note) {
      skipped.push(line);
      continue;
    }
    while (times.length < GRADES) times.push('');
    days[date] = { grades: times, note };
  }
  return { days, skipped };
}

function parsePastedDate(s, y, m) {
  if (!s) return null;
  s = s.replace(/[（(].*?[）)]/g, '').replace(/[年月]/g, '/').replace(/日/g, '').replace(/-/g, '/').trim();
  const parts = s.split('/').filter(Boolean).map(Number);
  if (parts.some(Number.isNaN)) return null;
  let yy = y, mm = m, dd;
  if (parts.length === 1) [dd] = parts;
  else if (parts.length === 2) [mm, dd] = parts;
  else if (parts.length === 3) [yy, mm, dd] = parts;
  else return null;
  const d = new Date(yy, mm - 1, dd);
  if (d.getFullYear() !== yy || d.getMonth() !== mm - 1 || d.getDate() !== dd) return null;
  return ymd(d);
}

// 時刻として読めれば 'HH:MM'、空欄や「-」なら ''、時刻でなければ null（備考として扱う）
function parsePastedTime(s) {
  if (!s || /^[-－―ー]$/.test(s)) return '';
  const z = s.replace(/[０-９：]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  const mt = z.match(/^(\d{1,2})[:時](\d{2})分?$/);
  if (!mt) return null;
  const h = Number(mt[1]);
  const min = Number(mt[2]);
  if (h > 23 || min > 59) return null;
  return `${pad(h)}:${pad(min)}`;
}

function renderPendingBar() {
  const bar = document.getElementById('pending-bar');
  if (!bar) return;
  const { changes, warnings } = state.pending;
  if (!changes.length) {
    bar.className = 'pending-bar clean no-print';
    bar.innerHTML = '✅ すべて公開済みです。学童・保護者には最新の内容が見えています。';
    return;
  }
  const dates = new Set(changes.map((c) => c.date)).size;
  bar.className = 'pending-bar no-print';
  bar.innerHTML = `
    <span>✏️ <b>未公開の変更が ${dates} 日分（${changes.length} 箇所）</b>あります。まだ学童・保護者には届いていません。
    ${warnings.length ? `<span class="tag revision">要確認 ${warnings.length}件</span>` : ''}</span>
    <span class="spacer"></span>
    <button class="btn danger" id="discard-btn">下書きを破棄</button>
    <button class="btn primary" id="publish-btn">変更内容を確認して公開する</button>`;
  bar.querySelector('#discard-btn').addEventListener('click', withErrors(async () => {
    if (!confirm('未公開の変更をすべて破棄して、公開中の内容に戻します。よろしいですか？')) return;
    await api('POST', '/api/school/discard');
    renderSchool();
  }));
  bar.querySelector('#publish-btn').addEventListener('click', withErrors(openPublishDialog));
}

async function openPublishDialog() {
  const links = await api('GET', '/api/school/links');
  const approved = links.filter((l) => l.status === 'approved');
  const { changes, warnings, urgentDates } = state.pending;
  const dlg = openDialog(`
    <form id="publish-form">
      <div class="dialog-body">
        <h2>この内容で公開しますか？</h2>
        ${urgentDates.length ? `<div class="alert">⚠️ <b>当日・翌日（${urgentDates.map(fmtDate).join('、')}）の変更が含まれます。</b><br>学童がすぐに気づけるよう強調して通知します。公開後、「公開履歴・確認状況」で未確認の学童には電話でもご連絡ください。</div>` : ''}
        ${warnings.length ? `<div class="alert"><b>入力ミスの可能性があります。ご確認ください：</b><ul>${warnings.map((w) => `<li>${esc(fmtDate(w.date))}：${esc(w.message)}</li>`).join('')}</ul></div>` : ''}
        <h3>変更点（${changes.length}箇所）</h3>
        ${changesHtml(changes, 30)}
        <label>お知らせ文（任意。学童と保護者に表示されます）
          <textarea name="message" maxlength="500" placeholder="例）3年生は校外学習のため、10/3の下校時刻を変更します。"></textarea>
        </label>
        <p class="muted">通知先：承認済みの学童 ${approved.length} か所${approved.length ? `（${approved.map((l) => esc(l.gakudoName)).join('、')}）` : ''}。保護者向けページにもすぐに反映され、通知を登録している保護者にも届きます。</p>
      </div>
      <div class="dialog-actions">
        <button type="button" class="btn" data-close>戻って修正する</button>
        <button class="btn primary" type="submit">公開する</button>
      </div>
    </form>`);
  dlg.querySelector('#publish-form').addEventListener('submit', withErrors(async (e) => {
    e.preventDefault();
    const btn = e.submitter;
    btn.disabled = true; // 二重送信防止
    try {
      const r = await api('POST', '/api/school/publish', { message: e.target.message.value });
      dlg.close();
      toast(`公開しました。${r.recipients.length}か所の学童に通知しました`);
      renderSchool();
    } finally {
      btn.disabled = false;
    }
  }));
}

async function renderSchoolReleases(el) {
  const releases = await api('GET', '/api/school/releases');
  if (!releases.length) {
    el.innerHTML = '<div class="card">まだ公開履歴はありません。</div>';
    return;
  }
  el.innerHTML = `<p class="muted">公開した内容と、各学童が確認したかどうかの一覧です。確認ボタンが押されると自動で更新されます。</p>
    ${releases.map((r) => {
      const done = r.acks.filter((a) => a.ackedAt).length;
      const waiting = r.acks.filter((a) => !a.ackedAt);
      return `<article class="card release">
        <div class="row">${releaseTags(r)}<span class="meta">${esc(fmtDateTime(r.publishedAt))} 公開 ／ ${esc(r.publishedByName)}</span>
          <span class="spacer"></span>
          <b class="${waiting.length ? 'text-danger' : 'text-ok'}">確認済み ${done} / ${r.acks.length}</b></div>
        ${r.message ? `<p class="message">${esc(r.message)}</p>` : ''}
        ${changesHtml(r.changes)}
        <div class="acks">${r.acks.map((a) => `<span class="ack${a.ackedAt ? ' done' : ''}">${esc(a.gakudoName)}：${a.ackedAt ? `確認済 ${esc(fmtDateTime(a.ackedAt))}` : `未確認${r.urgent && a.gakudoPhone ? `（☎ ${esc(a.gakudoPhone)}）` : ''}`}</span>`).join('')}</div>
        ${r.urgent && waiting.length ? '<p class="alert">当日・翌日の変更です。未確認の学童には念のため電話でのご連絡をおすすめします。</p>' : ''}
      </article>`;
    }).join('')}`;
}

function renderSchoolLinks(el, links) {
  const group = (status) => links.filter((l) => l.status === status);
  const item = (l, actions) => `<li class="link-item"><div><b>${esc(l.gakudoName)}</b>
      <span class="muted">${esc(l.gakudoMunicipality || '')}${l.gakudoPhone ? ` ☎ ${esc(l.gakudoPhone)}` : ''} ／ 申請日 ${esc(fmtDateTime(l.requestedAt))}</span></div>
      <div class="row">${actions}</div></li>`;
  const pending = group('pending');
  const approved = group('approved');
  const rejected = group('rejected');
  el.innerHTML = `
    <p class="muted">学童は運営事務局が登録した団体だけが申請できます。<b>学校が承認した学童にだけ</b>下校時刻が届きます。心当たりのない申請は承認しないでください。</p>
    <section class="card"><h2>承認待ち（${pending.length}）</h2>
      ${pending.length ? `<ul class="link-list">${pending.map((l) => item(l, `<button class="btn primary small" data-id="${l.id}" data-approve="1">承認する</button><button class="btn danger small" data-id="${l.id}" data-approve="0">承認しない</button>`)).join('')}</ul>` : '<p class="muted">承認待ちの申請はありません。</p>'}
    </section>
    <section class="card"><h2>受信中の学童（${approved.length}）</h2>
      ${approved.length ? `<ul class="link-list">${approved.map((l) => item(l, `<button class="btn danger small" data-id="${l.id}" data-approve="0" data-confirm="この学童への配信を停止します。よろしいですか？">配信を停止</button>`)).join('')}</ul>` : '<p class="muted">まだありません。</p>'}
    </section>
    ${rejected.length ? `<section class="card"><h2>承認しなかった・停止した学童（${rejected.length}）</h2>
      <ul class="link-list">${rejected.map((l) => item(l, `<button class="btn small" data-id="${l.id}" data-approve="1">承認する</button>`)).join('')}</ul></section>` : ''}`;
  el.querySelectorAll('button[data-id]').forEach((b) =>
    b.addEventListener('click', withErrors(async () => {
      if (b.dataset.confirm && !confirm(b.dataset.confirm)) return;
      await api('POST', `/api/school/links/${b.dataset.id}`, { approve: b.dataset.approve === '1' });
      renderSchool();
    })));
}

async function renderSchoolParent(el) {
  const link = await api('GET', '/api/school/parent-link');
  const url = `${location.origin}/?view=parent&school=${state.me.org.id}&code=${link.code}`;
  el.innerHTML = `
    <section class="card">
      <h2>保護者向け閲覧ページ</h2>
      <p>保護者はログインなしで、このリンクから公開済みの下校時刻を見られます。学校だより・メール配信などでお知らせください。<br>
      保護者がページで「通知を受け取る」を押すと、公開・修正のたびにスマホへ通知が届きます（現在の登録：<b>${link.pushCount}台</b>）。</p>
      ${link.enabled ? `
        <input class="share-url" readonly value="${esc(url)}">
        <div class="row"><button class="btn primary" id="copy-url">リンクをコピー</button><a class="btn" href="${esc(url)}" target="_blank" rel="noopener">開いて確認</a></div>`
        : '<p class="alert">現在、保護者向けページは<b>停止中</b>です。リンクを開いても表示されません。</p>'}
    </section>
    <section class="card">
      <h2>防犯上の配慮</h2>
      <ul>
        <li>リンクには推測できない長いコードが入っており、コードを知らない人は見られません。</li>
        <li>検索エンジン（Google 等）には載らない設定にしています。</li>
        <li>児童の氏名などの個人情報は一切含まれません。</li>
        <li>リンクが外部に広まった疑いがある場合は、下の「リンクを作り直す」で<b>古いリンクを即座に無効化</b>できます。</li>
      </ul>
      <div class="row">
        <button class="btn danger" id="regen">リンクを作り直す（古いリンクは無効に）</button>
        <button class="btn" id="toggle">${link.enabled ? '保護者向けページを停止する' : '保護者向けページを再開する'}</button>
      </div>
    </section>`;
  const copy = el.querySelector('#copy-url');
  if (copy) copy.addEventListener('click', async () => {
    await navigator.clipboard.writeText(url);
    toast('リンクをコピーしました');
  });
  el.querySelector('#regen').addEventListener('click', withErrors(async () => {
    if (!confirm('新しいリンクを作ります。これまでに配布したリンクは見られなくなり、保護者の通知登録もすべて解除されます。よろしいですか？')) return;
    await api('POST', '/api/school/parent-link', { regenerate: true });
    toast('新しいリンクを作りました。保護者へ再配布してください');
    renderSchool();
  }));
  el.querySelector('#toggle').addEventListener('click', withErrors(async () => {
    await api('POST', '/api/school/parent-link', { enabled: !link.enabled });
    renderSchool();
  }));
}

// ---------------------------------------------------------------- 学童

async function renderGakudo() {
  const releases = await api('GET', '/api/gakudo/releases');
  const unread = releases.filter((r) => !r.ackedAt);
  const body = document.createElement('div');
  appEl.innerHTML = pushBarHtml() + tabsHtml([
    ['today', '今日・今週の下校時刻'],
    ['month', '月の一覧'],
    ['news', 'お知らせ（公開・修正）', unread.length],
    ['schools', '受け取る学校・通知設定'],
    ...adminTabs(),
  ]);
  appEl.appendChild(body);
  bindTabs(renderGakudo);
  bindPushBar();
  if (await renderAdminTab(body)) return;
  if (state.tab === 'today') await renderGakudoToday(body, unread);
  if (state.tab === 'month') await renderGakudoMonth(body, unread);
  if (state.tab === 'news') renderGakudoNews(body, releases);
  if (state.tab === 'schools') await renderGakudoSchools(body);
}

// 未確認のお知らせで修正された箇所（月初の新規公開などは含めない）
function changedKeys(unread) {
  const changed = new Set();
  for (const r of unread) {
    for (const c of r.changes) if (c.before || c.field === 'note') changed.add(`${r.schoolId}|${c.date}|${c.grade || 'note'}`);
  }
  return changed;
}

// [1,2] → 「1・2年」、[4,5,6] → 「4〜6年」
function gradesText(gs) {
  if (gs.length === 1) return `${gs[0]}年`;
  const consecutive = gs.every((g, i) => i === 0 || g === gs[i - 1] + 1);
  if (consecutive && gs.length >= 3) return `${gs[0]}〜${gs[gs.length - 1]}年`;
  return `${gs.join('・')}年`;
}

// 全校まとめて、下校時刻の早い順に並べる
function pickupTimelineHtml(schools, date, changed) {
  const byTime = new Map();
  for (const s of schools) {
    const day = s.days[date];
    if (!day) continue;
    const groups = {};
    day.grades.forEach((t, i) => { if (t) (groups[t] = groups[t] || []).push(i + 1); });
    for (const [t, gs] of Object.entries(groups)) {
      if (!byTime.has(t)) byTime.set(t, []);
      byTime.get(t).push({ name: s.name, grades: gs, changed: gs.some((g) => changed.has(`${s.id}|${date}|${g}`)) });
    }
  }
  const notes = schools.filter((s) => s.days[date] && s.days[date].note);
  if (!byTime.size) return '<section class="card timeline"><h2>お迎え順の一覧</h2><p class="muted">この日の下校時刻はまだ公開されていません。</p></section>';
  return `<section class="card timeline"><h2>お迎え順の一覧（時刻の早い順）</h2>
    <table class="timeline-table"><tbody>${[...byTime.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([t, items]) => `<tr>
      <th>${esc(t)}</th><td>${items.map((it) => `<span class="pill${it.changed ? ' changed' : ''}">${esc(it.name)} ${gradesText(it.grades)}${it.changed ? '（修正）' : ''}</span>`).join('')}</td></tr>`).join('')}
    </tbody></table>
    ${notes.map((s) => `<div class="note-box${changed.has(`${s.id}|${date}|note`) ? ' changed' : ''}">📝 ${esc(s.name)}：${esc(s.days[date].note)}</div>`).join('')}
  </section>`;
}

async function renderGakudoToday(el, unread) {
  const week = weekDates(state.date);
  const schools = await api('GET', `/api/gakudo/schedule?from=${week[0]}&to=${week[6]}`);
  const changed = changedKeys(unread);
  const isToday = state.date === todayStr();

  el.innerHTML = `
    ${unread.length ? `<div class="alert row"><span>🔔 <b>未確認のお知らせが ${unread.length} 件</b>あります。赤く表示されている箇所は修正された時刻です。</span><span class="spacer"></span><button class="btn small" id="go-news">お知らせを確認する</button></div>` : ''}
    <div class="row no-print">
      <button class="btn" id="prev-day">◀ 前の日</button>
      <input type="date" id="day" value="${state.date}">
      <button class="btn" id="next-day">次の日 ▶</button>
      ${isToday ? '' : '<button class="btn" id="to-today">今日</button>'}
      <span class="spacer"></span>
      <button class="btn" id="print-day">印刷</button>
    </div>
    <h1>${esc(fmtDate(state.date))}${isToday ? '（今日）' : ''}の下校時刻</h1>
    ${schools.length ? pickupTimelineHtml(schools, state.date, changed) : '<div class="card">まだ受け取る学校がありません。「受け取る学校」タブから学校に申請してください。</div>'}
    <h2 class="print-break">学校ごとの下校時刻</h2>
    <div class="today-grid">${schools.map((s) => {
      const day = s.days[state.date];
      return `<section class="card school-card"><h3>${esc(s.name)}</h3>
        ${day ? `<div class="grade-times">${day.grades.map((g, i) => `<div class="${changed.has(`${s.id}|${state.date}|${i + 1}`) ? 'changed' : ''}"><div class="g">${i + 1}年</div><div class="t">${esc(timeText(g))}</div></div>`).join('')}</div>
          ${day.note ? `<div class="note-box${changed.has(`${s.id}|${state.date}|note`) ? ' changed' : ''}">📝 ${esc(day.note)}</div>` : ''}`
          : '<p class="muted">この日の下校時刻はまだ公開されていません。</p>'}
      </section>`;
    }).join('')}</div>
    ${schools.map((s) => `<section class="card"><h3>${esc(s.name)}：この週の予定</h3>
      <div class="table-wrap"><table class="grid"><thead><tr><th>日付</th>${Array.from({ length: GRADES }, (_, i) => `<th>${i + 1}年</th>`).join('')}<th>備考</th></tr></thead>
      <tbody>${week.filter((d) => s.days[d] || (dowOf(d) >= 1 && dowOf(d) <= 5)).map((d) => {
        const day = s.days[d];
        const dow = dowOf(d);
        return `<tr class="${dow === 0 ? 'sun' : dow === 6 ? 'sat' : ''}${d === state.date ? ' is-today' : ''}"><td class="date">${esc(fmtDate(d))}</td>
          ${day ? day.grades.map((g, i) => `<td class="time${changed.has(`${s.id}|${d}|${i + 1}`) ? ' changed-cell' : ''}">${esc(timeText(g))}</td>`).join('') + `<td class="${changed.has(`${s.id}|${d}|note`) ? 'changed-cell' : ''}">${esc(day.note)}</td>`
            : `<td colspan="${GRADES + 1}" class="muted">未公開</td>`}</tr>`;
      }).join('')}</tbody></table></div></section>`).join('')}`;

  const setDate = (d) => { if (d) { state.date = d; renderGakudo(); } };
  el.querySelector('#prev-day').addEventListener('click', () => setDate(addDays(state.date, -1)));
  el.querySelector('#next-day').addEventListener('click', () => setDate(addDays(state.date, 1)));
  el.querySelector('#day').addEventListener('change', (e) => setDate(e.target.value));
  const toToday = el.querySelector('#to-today');
  if (toToday) toToday.addEventListener('click', () => setDate(todayStr()));
  const goNews = el.querySelector('#go-news');
  if (goNews) goNews.addEventListener('click', () => { state.tab = 'news'; renderGakudo(); });
  el.querySelector('#print-day').addEventListener('click', () => window.print());
}

async function renderGakudoMonth(el, unread) {
  if (!state.month) state.month = todayStr().slice(0, 7);
  const dates = monthDates(state.month);
  const schools = await api('GET', `/api/gakudo/schedule?from=${dates[0]}&to=${dates[dates.length - 1]}`);
  const changed = changedKeys(unread);
  const today = todayStr();
  el.innerHTML = `
    <div class="row">
      <button class="btn no-print" id="prev-month">◀ 前の月</button>
      <h1>${fmtMonth(state.month)}の下校時刻</h1>
      <button class="btn no-print" id="next-month">次の月 ▶</button>
      <span class="spacer"></span>
      <button class="btn no-print" id="print-month">印刷</button>
    </div>
    ${schools.length ? '' : '<div class="card">まだ受け取る学校がありません。「受け取る学校」タブから学校に申請してください。</div>'}
    ${schools.map((s) => `<section class="card month-school"><h2>${esc(s.name)}</h2>
      <div class="table-wrap"><table class="grid"><thead><tr><th>日付</th>${Array.from({ length: GRADES }, (_, i) => `<th>${i + 1}年</th>`).join('')}<th>備考</th></tr></thead>
      <tbody>${dates.filter((d) => s.days[d] || (dowOf(d) >= 1 && dowOf(d) <= 5)).map((d) => {
        const day = s.days[d];
        const dow = dowOf(d);
        return `<tr class="${dow === 0 ? 'sun' : dow === 6 ? 'sat' : ''}${d === today ? ' is-today' : ''}"><td class="date">${esc(fmtDate(d))}</td>
          ${day ? day.grades.map((g, i) => `<td class="time${changed.has(`${s.id}|${d}|${i + 1}`) ? ' changed-cell' : ''}">${esc(timeText(g))}</td>`).join('') + `<td class="${changed.has(`${s.id}|${d}|note`) ? 'changed-cell' : ''}">${esc(day.note)}</td>`
            : `<td colspan="${GRADES + 1}" class="muted">未公開</td>`}</tr>`;
      }).join('')}</tbody></table></div></section>`).join('')}`;
  el.querySelector('#prev-month').addEventListener('click', () => { state.month = shiftMonth(state.month, -1); renderGakudo(); });
  el.querySelector('#next-month').addEventListener('click', () => { state.month = shiftMonth(state.month, 1); renderGakudo(); });
  el.querySelector('#print-month').addEventListener('click', () => window.print());
}

function renderGakudoNews(el, releases) {
  if (!releases.length) {
    el.innerHTML = '<div class="card">まだお知らせはありません。</div>';
    return;
  }
  el.innerHTML = `<p class="muted">内容を確認したら「確認しました」を押してください。学校側に確認済みと表示されます。</p>
    ${releases.map((r) => `<article class="card release${r.ackedAt ? '' : ' unread'}">
      <div class="row"><b>${esc(r.schoolName)}</b>${releaseTags(r)}<span class="meta">${esc(fmtDateTime(r.publishedAt))}</span></div>
      ${r.message ? `<p class="message">${esc(r.message)}</p>` : ''}
      ${changesHtml(r.changes)}
      <div class="row">${r.ackedAt ? `<span class="tag ok">確認済み ${esc(fmtDateTime(r.ackedAt))}</span>` : `<button class="btn primary" data-ack="${r.id}">確認しました</button>`}</div>
    </article>`).join('')}`;
  el.querySelectorAll('[data-ack]').forEach((b) =>
    b.addEventListener('click', withErrors(async () => {
      b.disabled = true;
      await api('POST', `/api/gakudo/releases/${b.dataset.ack}/ack`);
      renderGakudo();
    })));
}

async function renderGakudoSchools(el) {
  const [schools, links] = await Promise.all([api('GET', '/api/gakudo/schools'), api('GET', '/api/gakudo/links')]);
  const byId = Object.fromEntries(links.map((l) => [l.schoolId, l]));
  const areas = [...new Set(schools.map((s) => s.municipality))];
  el.innerHTML = `
    <section class="card"><h2>このパソコン・スマホへの通知</h2>
      ${state.pushOn
        ? '<p>✅ 通知はオンです。画面を閉じていても、公開・修正があれば通知が届きます。</p><button class="btn small" id="push-off">この端末の通知をオフにする</button>'
        : '<p>通知はオフです。上の「通知をオンにする」を押してください。職員が使う端末ごとに設定できます。</p>'}
    </section>
    <p class="muted">児童が通っている学校に「受信を申請」してください。学校が承認すると下校時刻が届くようになります。</p>
    ${areas.map((area) => `<section class="card"><h2>${esc(area)}</h2><ul class="link-list">
      ${schools.filter((s) => s.municipality === area).map((s) => {
        const l = byId[s.id];
        const st = !l ? '<button class="btn primary small" data-req="' + s.id + '">受信を申請</button>'
          : l.status === 'pending' ? '<span class="tag draft">承認待ち</span><button class="btn small" data-cancel="' + s.id + '">申請を取り消す</button>'
            : l.status === 'approved' ? '<span class="tag ok">受信中</span><button class="btn small danger" data-cancel="' + s.id + '">受信をやめる</button>'
              : '<span class="tag revision">承認されませんでした</span><button class="btn small" data-req="' + s.id + '">再申請</button>';
        return `<li class="link-item"><div>${esc(s.name)}</div><div class="row">${st}</div></li>`;
      }).join('')}</ul></section>`).join('')}`;
  const off = el.querySelector('#push-off');
  if (off) off.addEventListener('click', withErrors(async () => {
    await disablePush('/api/gakudo/push');
    storageSet('gakudo-push', null);
    state.pushOn = false;
    toast('この端末の通知をオフにしました');
    renderGakudo();
  }));
  el.querySelectorAll('[data-req]').forEach((b) =>
    b.addEventListener('click', withErrors(async () => {
      await api('POST', '/api/gakudo/links', { schoolId: b.dataset.req });
      toast('申請しました。学校の承認をお待ちください');
      renderGakudo();
    })));
  el.querySelectorAll('[data-cancel]').forEach((b) =>
    b.addEventListener('click', withErrors(async () => {
      if (!confirm('この学校の下校時刻を受け取らないようにします。よろしいですか？')) return;
      await api('DELETE', `/api/gakudo/links/${b.dataset.cancel}`);
      renderGakudo();
    })));
}

// ---------------------------------------------------------------- 管理（協議会・市町村・各校/学童の管理職）

const TYPE_LABEL = { council: '連絡協議会', board: '市町村（教育委員会等）', school: '学校', gakudo: '学童' };

// 学校・学童の管理職に出す追加タブ
function adminTabs() {
  return state.me.user.isAdmin ? [['staff', '職員アカウント'], ['audit', '操作履歴']] : [];
}

async function renderAdminTab(el) {
  if (state.tab === 'staff') await renderManageOrgs(el);
  else if (state.tab === 'audit') await renderAudit(el);
  else return false;
  return true;
}

async function renderManage() {
  const { org } = state.me;
  const isCouncil = org.type === 'council';
  const scope = isCouncil
    ? '利根沼田地域の全体（すべての市町村・学校・学童）'
    : `${org.municipality}の${org.manages.map((t) => TYPE_LABEL[t]).join('・')}`;
  const body = document.createElement('div');
  appEl.innerHTML = `
    <h1>${isCouncil ? '連絡協議会 管理画面' : `${esc(org.name)} 管理画面`}</h1>
    <p class="muted">管理できる範囲：<b>${esc(scope)}</b>。下校時刻の入力・公開は各学校が行います。この画面ではアカウントの発行・停止と、操作履歴の確認を行います。</p>
    ${tabsHtml([
      ['orgs', '組織・アカウント'],
      ['audit', '操作履歴'],
      ...(isCouncil ? [['settings', '全体設定・データ管理']] : []),
    ])}`;
  appEl.appendChild(body);
  bindTabs(renderManage);
  if (state.tab === 'orgs') await renderManageOrgs(body);
  if (state.tab === 'audit') await renderAudit(body);
  if (state.tab === 'settings') await renderCouncilSettings(body);
}

function fmtLastLogin(iso) {
  return iso ? fmtDateTime(iso) : '未ログイン';
}

async function renderManageOrgs(el) {
  const orgs = await api('GET', '/api/manage/orgs');
  const own = state.me.org;
  const creatable = own.type === 'council' ? ['board', 'school', 'gakudo'] : own.type === 'board' ? own.manages : [];
  const types = ['council', 'board', 'school', 'gakudo'].filter((t) => orgs.some((o) => o.type === t));
  el.innerHTML = `
    ${own.type === 'school' || own.type === 'gakudo' ? `<p class="muted">異動・退職した職員のアカウントは<b>停止</b>してください（履歴に名前を残すため、削除ではなく停止にしています）。新しく来た職員のアカウントはここで発行できます。</p>` : ''}
    ${creatable.length ? `<section class="card">
      <h2>組織を登録</h2>
      <form id="org-form" class="org-form">
        <select name="type">${creatable.map((t) => `<option value="${t}">${TYPE_LABEL[t]}</option>`).join('')}</select>
        <input name="name" placeholder="名前（例：沼田市立〇〇小学校）" required>
        ${own.type === 'council' ? '<input name="municipality" placeholder="市町村（例：沼田市）">' : `<span class="muted">市町村：${esc(own.municipality)}</span>`}
        <input name="phone" placeholder="電話番号（学童は緊急連絡用）">
        <span class="board-only chk-group">管理対象：<label class="chk"><input type="checkbox" name="manages" value="school" checked>学校</label><label class="chk"><input type="checkbox" name="manages" value="gakudo">学童</label></span>
        <button class="btn primary">登録</button>
      </form>
    </section>` : ''}
    ${types.map((type) => `<section class="card"><h2>${TYPE_LABEL[type]}</h2>
      ${orgs.filter((o) => o.type === type).map((o) => `<div class="org-block">
        <div class="row"><h3>${esc(o.name)}</h3><span class="muted">${esc(o.municipality)}${o.manages ? ` ／ 管理対象：${o.manages.map((t) => TYPE_LABEL[t]).join('・')}` : ''}${o.phone ? ` ／ ☎ ${esc(o.phone)}` : ''}</span>
          <span class="spacer"></span>
          <button class="btn small" data-edit-org="${o.id}" data-name="${esc(o.name)}" data-phone="${esc(o.phone || '')}">名前・電話を変更</button>
          <button class="btn small primary" data-add-user="${o.id}" data-org="${esc(o.name)}">アカウント発行</button></div>
        <div class="table-wrap"><table class="grid users-table"><thead><tr><th>氏名・役職</th><th>ログインID</th><th>権限</th><th>状態</th><th>2段階認証</th><th>最終ログイン</th><th></th></tr></thead><tbody>
        ${o.users.map((u) => `<tr class="${u.disabled ? 'disabled-row' : ''}"><td class="date">${esc(u.name)}</td><td><code>${esc(u.loginId)}</code></td>
          <td>${u.role === 'manager' ? '管理者' : '職員'}</td>
          <td>${u.disabled ? '<span class="tag revision">停止中</span>' : '<span class="tag ok">利用中</span>'}</td>
          <td>${u.mfaEnabled ? '設定済' : '<span class="muted">未設定</span>'}</td>
          <td>${esc(fmtLastLogin(u.lastLoginAt))}</td>
          <td class="row-actions">${u.id === state.me.user.id ? '<span class="muted">（自分）</span>' : `
            <button class="btn small" data-reset="${u.id}" data-name="${esc(u.name)}">パスワード再発行</button>
            ${u.mfaEnabled ? `<button class="btn small" data-mfa-reset="${u.id}" data-name="${esc(u.name)}">2段階認証を解除</button>` : ''}
            <button class="btn small ${u.disabled ? '' : 'danger'}" data-disable="${u.id}" data-to="${u.disabled ? '0' : '1'}" data-name="${esc(u.name)}">${u.disabled ? '再開' : '停止'}</button>`}</td></tr>`).join('') || `<tr><td colspan="7" class="muted">アカウントがありません</td></tr>`}
        </tbody></table></div></div>`).join('')}
    </section>`).join('')}`;

  const form = el.querySelector('#org-form');
  if (form) {
    const syncBoard = () => el.querySelector('.board-only').classList.toggle('hidden', form.type.value !== 'board');
    form.type.addEventListener('change', syncBoard);
    syncBoard();
    form.addEventListener('submit', withErrors(async (e) => {
      e.preventDefault();
      await api('POST', '/api/manage/orgs', {
        type: form.type.value,
        name: form.name.value,
        municipality: form.municipality ? form.municipality.value : own.municipality,
        phone: form.phone.value,
        manages: [...form.querySelectorAll('[name=manages]:checked')].map((c) => c.value),
      });
      toast('登録しました。続けてアカウントを発行してください');
      renderAdminView();
    }));
  }
  el.querySelectorAll('[data-add-user]').forEach((b) =>
    b.addEventListener('click', () => {
      const dlg = openDialog(`<form id="user-form"><div class="dialog-body"><h2>${esc(b.dataset.org)}：アカウント発行</h2>
        <label>氏名・役職<input name="name" required placeholder="例）教頭 沼田太郎"></label>
        <label>ログインID（半角英数字）<input name="loginId" required pattern="[A-Za-z0-9._\-]{3,40}"></label>
        <label>初期パスワード（8文字以上）<input name="password" required minlength="8"></label>
        <label>権限<select name="role"><option value="staff">職員（下校時刻の入力・確認など）</option><option value="manager">管理者（上記＋職員アカウントの管理）</option></select></label>
        <p class="muted">初期パスワードは本人に直接伝え、最初のログイン後に変更してもらってください。</p></div>
        <div class="dialog-actions"><button type="button" class="btn" data-close>キャンセル</button><button class="btn primary">発行する</button></div></form>`);
      dlg.querySelector('#user-form').addEventListener('submit', withErrors(async (e) => {
        e.preventDefault();
        const f = e.target;
        await api('POST', '/api/manage/users', { orgId: b.dataset.addUser, name: f.name.value, loginId: f.loginId.value, password: f.password.value, role: f.role.value });
        dlg.close();
        toast('アカウントを発行しました');
        renderAdminView();
      }));
    }));
  el.querySelectorAll('[data-edit-org]').forEach((b) =>
    b.addEventListener('click', () => {
      const dlg = openDialog(`<form id="org-edit"><div class="dialog-body"><h2>組織情報の変更</h2>
        <label>名前<input name="name" required value="${esc(b.dataset.name)}"></label>
        <label>電話番号<input name="phone" value="${esc(b.dataset.phone)}"></label></div>
        <div class="dialog-actions"><button type="button" class="btn" data-close>キャンセル</button><button class="btn primary">保存</button></div></form>`);
      dlg.querySelector('#org-edit').addEventListener('submit', withErrors(async (e) => {
        e.preventDefault();
        await api('POST', `/api/manage/orgs/${b.dataset.editOrg}`, { name: e.target.name.value, phone: e.target.phone.value });
        dlg.close();
        renderAdminView();
      }));
    }));
  el.querySelectorAll('[data-reset]').forEach((b) =>
    b.addEventListener('click', withErrors(async () => {
      const pw = prompt(`${b.dataset.name} さんの新しいパスワード（8文字以上）を入力してください。\n本人のログイン中の画面は自動的にログアウトされます。`);
      if (!pw) return;
      await api('POST', `/api/manage/users/${b.dataset.reset}/password`, { password: pw });
      toast('パスワードを再発行しました。本人に直接伝えてください');
    })));
  el.querySelectorAll('[data-mfa-reset]').forEach((b) =>
    b.addEventListener('click', withErrors(async () => {
      if (!confirm(`${b.dataset.name} さんの2段階認証を解除します（スマホの紛失・機種変更時）。\n本人確認をしてから行ってください。よろしいですか？`)) return;
      await api('POST', `/api/manage/users/${b.dataset.mfaReset}/mfa-reset`);
      toast('解除しました。本人は次回ログイン時に設定し直します');
      renderAdminView();
    })));
  el.querySelectorAll('[data-disable]').forEach((b) =>
    b.addEventListener('click', withErrors(async () => {
      const stop = b.dataset.to === '1';
      if (stop && !confirm(`${b.dataset.name} さんのアカウントを停止します（異動・退職時など）。すぐにログアウトされ、ログインできなくなります。よろしいですか？`)) return;
      await api('POST', `/api/manage/users/${b.dataset.disable}/disabled`, { disabled: stop });
      toast(stop ? '停止しました' : '再開しました');
      renderAdminView();
    })));
}

function renderAdminView() {
  const type = state.me.org.type;
  if (type === 'school') return renderSchool();
  if (type === 'gakudo') return renderGakudo();
  return renderManage();
}

async function renderAudit(el) {
  const logs = await api('GET', '/api/manage/audit?limit=500');
  el.innerHTML = `
    <p class="muted">ログイン・公開・承認・アカウント操作などの記録です（新しい順に最大500件）。記録は変更・削除できません。</p>
    <div class="table-wrap"><table class="grid audit-table"><thead><tr><th>日時</th><th>組織</th><th>操作した人</th><th>操作</th><th>対象・内容</th><th>接続元</th></tr></thead><tbody>
    ${logs.map((a) => `<tr class="${/失敗/.test(a.action) ? 'audit-fail' : ''}"><td class="date">${esc(fmtDateTime(a.at))}</td><td class="date">${esc(a.orgName || '―')}</td>
      <td class="date">${esc(a.userName || '―')}${a.loginId ? `<br><small class="muted">${esc(a.loginId)}</small>` : ''}</td><td class="date">${esc(a.action)}</td>
      <td class="date">${esc([a.target, a.detail].filter(Boolean).join(' ／ '))}</td><td><small>${esc(a.ip)}</small></td></tr>`).join('') || '<tr><td colspan="6" class="muted">記録がありません</td></tr>'}
    </tbody></table></div>`;
}

async function renderCouncilSettings(el) {
  const settings = await api('GET', '/api/council/settings');
  const fiscalStart = (() => {
    const d = new Date();
    const y = d.getMonth() >= 3 ? d.getFullYear() - 1 : d.getFullYear() - 2; // 前年度の4月1日
    return `${y}-04-01`;
  })();
  el.innerHTML = `
    <section class="card"><h2>2段階認証を必須にする範囲</h2>
      <p class="muted">必須にした種類のアカウントは、次回ログイン時に設定を求められます。</p>
      <form id="mfa-policy">${['council', 'board', 'school', 'gakudo'].map((t) => `<label class="chk"><input type="checkbox" name="${t}" ${settings.mfaRequired[t] ? 'checked' : ''} ${t === 'council' ? 'disabled' : ''}>${TYPE_LABEL[t]}</label>`).join('')}
        <button class="btn primary small">保存</button></form>
      <p class="muted">連絡協議会は常に必須です。</p>
    </section>
    <section class="card"><h2>保存期間を過ぎたデータの削除</h2>
      <p>指定した日より前の下校時刻と公開履歴を削除します（運用規程の保存期間に合わせて、年度ごとに行ってください）。操作履歴は削除されません。</p>
      <form id="purge-form" class="row"><input type="date" name="before" value="${fiscalStart}" required><span>より前を</span><button class="btn danger">削除する</button></form>
    </section>
    <section class="card row"><span><b>バックアップ</b>：全データを1つのファイルとして保存します（パスワードは暗号化された状態で含まれます）。保存したファイルは庁内の規程に従って厳重に保管してください。取得したことは操作履歴に記録されます。</span>
      <span class="spacer"></span><a class="btn" href="/api/council/backup" download>バックアップを保存</a></section>`;
  el.querySelector('#mfa-policy').addEventListener('submit', withErrors(async (e) => {
    e.preventDefault();
    const f = e.target;
    await api('POST', '/api/council/settings', { mfaRequired: { council: true, board: f.board.checked, school: f.school.checked, gakudo: f.gakudo.checked } });
    toast('保存しました');
  }));
  el.querySelector('#purge-form').addEventListener('submit', withErrors(async (e) => {
    e.preventDefault();
    const before = e.target.before.value;
    if (!confirm(`${before} より前の下校時刻と公開履歴を削除します。元に戻せません。よろしいですか？`)) return;
    const r = await api('POST', '/api/council/purge', { before });
    toast(`削除しました（下校時刻 ${r.days}日分・公開履歴 ${r.releases}件）`);
  }));
}

// ---------------------------------------------------------------- 保護者（ログイン不要）

async function renderParent(params) {
  const month = params.get('month') || todayStr().slice(0, 7);
  const school = params.get('school') || '';
  const code = params.get('code') || '';
  const q = `code=${encodeURIComponent(code)}`;
  const pushUrl = `/api/public/schools/${encodeURIComponent(school)}/push?${q}`;
  const pushKey = `parent-push-${school}`;
  try {
    const data = await api('GET', `/api/public/schools/${encodeURIComponent(school)}?${q}&month=${month}`);
    // 以前に通知をオンにしていれば、登録をサーバーに送り直す（リンク作り直し後などに備える）
    let pushOn = false;
    try {
      const sub = await currentPushSubscription();
      pushOn = Boolean(sub && storageGet(pushKey) === code);
      if (pushOn) await api('POST', pushUrl, { subscription: sub.toJSON() });
    } catch {
      pushOn = false;
    }
    const go = (m) => {
      const p = new URLSearchParams(params);
      p.set('month', m);
      history.replaceState(null, '', `?${p}`);
      renderParent(p);
    };
    const today = todayStr();
    const dates = monthDates(month).filter((d) => data.days[d] || (dowOf(d) >= 1 && dowOf(d) <= 5));
    const changed = new Set();
    for (const u of data.updates) for (const c of u.changes) changed.add(`${c.date}|${c.grade || 'note'}`);
    appEl.innerHTML = `
      <h1>${esc(data.school.name)} 下校時刻</h1>
      <section class="card no-print row">
        ${pushOn
          ? '<span>✅ 変更があるとこの端末に通知が届きます。</span><span class="spacer"></span><button class="btn small" id="push-off">通知をやめる</button>'
          : '<span>🔔 下校時刻が変わったときに、この端末へ<b>通知</b>を受け取れます（登録は匿名です。名前やメールアドレスは不要）。</span><span class="spacer"></span><button class="btn primary small" id="push-on">通知を受け取る</button>'}
      </section>
      ${data.updates.length ? `<section class="card updates"><h2>最近の変更</h2>
        ${data.updates.map((u) => `<div class="update">
          <div class="row"><span class="tag revision">修正</span>${u.urgent ? '<span class="tag urgent">当日・翌日の変更</span>' : ''}<span class="meta muted">${esc(fmtDateTime(u.publishedAt))}</span></div>
          ${u.message ? `<p class="message">${esc(u.message)}</p>` : ''}${changesHtml(u.changes, 6)}</div>`).join('')}
      </section>` : ''}
      <div class="row">
        <button class="btn no-print" id="prev">◀ 前の月</button>
        <h2>${fmtMonth(month)}</h2>
        <button class="btn no-print" id="next">次の月 ▶</button>
        <span class="spacer"></span>
        <button class="btn no-print" id="print">印刷</button>
      </div>
      <div class="table-wrap"><table class="grid"><thead><tr><th>日付</th>${Array.from({ length: GRADES }, (_, i) => `<th>${i + 1}年</th>`).join('')}<th>備考</th></tr></thead>
      <tbody>${dates.map((d) => {
        const day = data.days[d];
        const dow = dowOf(d);
        return `<tr class="${dow === 0 ? 'sun' : dow === 6 ? 'sat' : ''}${d === today ? ' is-today' : ''}"><td class="date">${esc(fmtDate(d))}</td>
          ${day ? day.grades.map((g, i) => `<td class="time${changed.has(`${d}|${i + 1}`) ? ' changed-cell' : ''}">${esc(timeText(g))}</td>`).join('') + `<td class="${changed.has(`${d}|note`) ? 'changed-cell' : ''}">${esc(day.note)}</td>` : `<td colspan="${GRADES + 1}" class="muted">未定</td>`}</tr>`;
      }).join('')}</tbody></table></div>
      <p class="muted">赤い箇所は最近修正された時刻です。学校が公開した時点で自動的に反映されます。<br>
      防犯のため、このページのリンクは学校関係者以外に教えないでください。<br>
      <a href="/terms.html">利用規約・プライバシーポリシー（案）</a></p>`;
    appEl.querySelector('#prev').addEventListener('click', () => go(shiftMonth(month, -1)));
    appEl.querySelector('#next').addEventListener('click', () => go(shiftMonth(month, 1)));
    appEl.querySelector('#print').addEventListener('click', () => window.print());
    const on = appEl.querySelector('#push-on');
    if (on) on.addEventListener('click', withErrors(async () => {
      await enablePush(pushUrl);
      storageSet(pushKey, code);
      toast('通知を受け取る設定にしました');
      renderParent(params);
    }));
    const off = appEl.querySelector('#push-off');
    if (off) off.addEventListener('click', withErrors(async () => {
      await disablePush(pushUrl);
      storageSet(pushKey, null);
      toast('通知をやめました');
      renderParent(params);
    }));
  } catch (err) {
    appEl.innerHTML = `<div class="card">${esc(err.message)}</div>`;
  }
}

boot();
