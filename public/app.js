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
  startEvents();
  const type = state.me.org.type;
  if (type === 'school') {
    state.tab = 'input';
    state.month = todayStr().slice(0, 7);
    renderSchool();
  } else if (type === 'gakudo') {
    state.tab = 'today';
    state.date = todayStr();
    renderGakudo();
    askNotificationPermission();
  } else {
    renderAdmin();
  }
}

function renderLogin() {
  accountEl.innerHTML = '';
  const demo = [
    ['school1', '学校（沼田第一小）'],
    ['school2', '学校（沼田第二小）'],
    ['gakudo1', '学童（学習塾 学童クラブ）'],
    ['gakudo2', '学童（放課後児童クラブ）'],
    ['gakudo3', '学童（みなかみ学童）'],
    ['admin', '運営事務局'],
  ];
  appEl.innerHTML = `
    <div class="card login">
      <h1>ログイン</h1>
      <p class="muted">学校・学童の職員の方は、運営事務局から発行されたIDでログインしてください。<br>保護者の方は、学校から配布されたリンクから閲覧できます（ログイン不要）。</p>
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
        <p class="muted">デモ用アカウント（パスワードはすべて <code>demo1234</code>）</p>
        ${demo.map(([id, label]) => `<button class="btn small" data-demo="${id}">${esc(label)}</button>`).join('')}
      </div>
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
      await api('POST', '/api/login', { loginId: form.loginId.value.trim(), password: form.password.value });
      location.reload();
    } catch (err) {
      document.getElementById('login-error').textContent = err.message;
    }
  });
}

function renderAccount() {
  const { user, org } = state.me;
  accountEl.innerHTML = `
    <span>${esc(org.name)}<br><small>${esc(user.name)}</small></span>
    <button class="btn small" id="pw-btn">パスワード変更</button>
    <button class="btn small" id="logout-btn">ログアウト</button>`;
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

function askNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    const bar = document.createElement('div');
    bar.className = 'card notice no-print';
    bar.innerHTML = `このパソコン・スマホに通知を出すと、画面を見ていなくても変更に気づけます。
      <button class="btn small primary" id="notify-ok">通知を許可する</button>`;
    appEl.before(bar);
    bar.querySelector('#notify-ok').addEventListener('click', async () => {
      await Notification.requestPermission();
      bar.remove();
    });
  }
}

// ---- リアルタイム通知 ----

function startEvents() {
  const es = new EventSource('/api/events');
  es.addEventListener('release', (e) => {
    const r = JSON.parse(e.data);
    const title = `${r.schoolName}が下校時刻を${r.kind === 'revision' ? '修正' : '公開'}しました`;
    const detail = r.urgent ? `【当日・翌日の変更】${r.urgentDates.map(fmtDate).join('、')}` : `${r.changes.length}件の変更`;
    toast(`${title}（${detail}）`, { alert: r.urgent || r.kind === 'revision' });
    desktopNotify(title, detail);
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
  ]);
  appEl.appendChild(body);
  bindTabs(renderSchool);
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
        <label>学童へのひとこと（任意。変更の理由など）
          <textarea name="message" maxlength="500" placeholder="例）3年生は校外学習のため、10/3の下校時刻を変更します。"></textarea>
        </label>
        <p class="muted">通知先：承認済みの学童 ${approved.length} か所${approved.length ? `（${approved.map((l) => esc(l.gakudoName)).join('、')}）` : ''}。保護者向けページにもすぐに反映されます。</p>
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
      <p>保護者はログインなしで、このリンクから公開済みの下校時刻を見られます。学校だより・メール配信などでお知らせください。</p>
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
    if (!confirm('新しいリンクを作ります。これまでに配布したリンクは見られなくなります。よろしいですか？')) return;
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
  appEl.innerHTML = tabsHtml([
    ['today', '今日・今週の下校時刻'],
    ['news', 'お知らせ（公開・修正）', unread.length],
    ['schools', '受け取る学校'],
  ]);
  appEl.appendChild(body);
  bindTabs(renderGakudo);
  if (state.tab === 'today') await renderGakudoToday(body, unread);
  if (state.tab === 'news') renderGakudoNews(body, releases);
  if (state.tab === 'schools') await renderGakudoSchools(body);
}

async function renderGakudoToday(el, unread) {
  const week = weekDates(state.date);
  const schools = await api('GET', `/api/gakudo/schedule?from=${week[0]}&to=${week[6]}`);
  // 未確認のお知らせで変わった箇所を強調する
  const changed = new Set();
  // 月初の新規公開などは強調せず、公開済みの時刻が修正された箇所だけを赤くする
  for (const r of unread) {
    for (const c of r.changes) if (c.before || c.field === 'note') changed.add(`${r.schoolId}|${c.date}|${c.grade || 'note'}`);
  }
  const isToday = state.date === todayStr();

  el.innerHTML = `
    ${unread.length ? `<div class="alert row"><span>🔔 <b>未確認のお知らせが ${unread.length} 件</b>あります。赤く表示されている箇所は修正された時刻です。</span><span class="spacer"></span><button class="btn small" id="go-news">お知らせを確認する</button></div>` : ''}
    <div class="row">
      <button class="btn" id="prev-day">◀ 前の日</button>
      <input type="date" id="day" value="${state.date}">
      <button class="btn" id="next-day">次の日 ▶</button>
      ${isToday ? '' : '<button class="btn" id="to-today">今日</button>'}
    </div>
    <h1>${esc(fmtDate(state.date))}${isToday ? '（今日）' : ''}の下校時刻</h1>
    ${schools.length ? '' : '<div class="card">まだ受け取る学校がありません。「受け取る学校」タブから学校に申請してください。</div>'}
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

// ---------------------------------------------------------------- 運営事務局

async function renderAdmin() {
  const orgs = await api('GET', '/api/admin/orgs');
  const label = { school: '学校', gakudo: '学童', admin: '運営事務局' };
  appEl.innerHTML = `
    <h1>アカウント管理（運営事務局）</h1>
    <p class="muted">学校・学童のアカウントは事務局だけが発行できます。先生・職員ごとにアカウントを分けると、誰が公開したか履歴に残ります。</p>
    <section class="card">
      <h2>学校・学童を追加</h2>
      <form id="org-form" class="row">
        <select name="type"><option value="school">学校</option><option value="gakudo">学童</option></select>
        <input name="name" placeholder="名前" required>
        <input name="municipality" placeholder="市町村（例：沼田市）">
        <input name="phone" placeholder="電話番号（学童のみ・緊急連絡用）">
        <button class="btn primary">追加</button>
      </form>
    </section>
    ${['school', 'gakudo', 'admin'].map((type) => `<section class="card"><h2>${label[type]}</h2>
      <div class="table-wrap"><table class="grid admin-table"><thead><tr><th>名前</th><th>市町村</th><th>アカウント</th><th></th></tr></thead><tbody>
      ${orgs.filter((o) => o.type === type).map((o) => `<tr><td class="date">${esc(o.name)}${o.phone ? `<br><small class="muted">☎ ${esc(o.phone)}</small>` : ''}</td><td>${esc(o.municipality)}</td>
        <td class="date">${o.users.map((u) => `<div class="user-line">${esc(u.name)} <code>${esc(u.loginId)}</code>
          <button class="btn small" data-reset="${u.id}">パスワード再発行</button>
          <button class="btn small danger" data-del="${u.id}" data-name="${esc(u.name)}">削除</button></div>`).join('') || '<span class="muted">なし</span>'}</td>
        <td><button class="btn small" data-add-user="${o.id}" data-org="${esc(o.name)}">アカウント追加</button></td></tr>`).join('')}
      </tbody></table></div></section>`).join('')}`;

  appEl.querySelector('#org-form').addEventListener('submit', withErrors(async (e) => {
    e.preventDefault();
    const f = e.target;
    await api('POST', '/api/admin/orgs', { type: f.type.value, name: f.name.value, municipality: f.municipality.value, phone: f.phone.value });
    toast('追加しました。続けてアカウントを発行してください');
    renderAdmin();
  }));
  appEl.querySelectorAll('[data-add-user]').forEach((b) =>
    b.addEventListener('click', () => {
      const dlg = openDialog(`<form id="user-form"><div class="dialog-body"><h2>${esc(b.dataset.org)}：アカウント追加</h2>
        <label>氏名・役職<input name="name" required placeholder="例）教頭 沼田太郎"></label>
        <label>ログインID（半角英数字）<input name="loginId" required pattern="[A-Za-z0-9._\\-]{3,40}"></label>
        <label>初期パスワード（8文字以上）<input name="password" required minlength="8"></label>
        <p class="muted">初回ログイン後、本人にパスワードを変更してもらってください。</p></div>
        <div class="dialog-actions"><button type="button" class="btn" data-close>キャンセル</button><button class="btn primary">発行する</button></div></form>`);
      dlg.querySelector('#user-form').addEventListener('submit', withErrors(async (e) => {
        e.preventDefault();
        const f = e.target;
        await api('POST', '/api/admin/users', { orgId: b.dataset.addUser, name: f.name.value, loginId: f.loginId.value, password: f.password.value });
        dlg.close();
        renderAdmin();
      }));
    }));
  appEl.querySelectorAll('[data-reset]').forEach((b) =>
    b.addEventListener('click', withErrors(async () => {
      const pw = prompt('新しいパスワード（8文字以上）を入力してください');
      if (!pw) return;
      await api('POST', `/api/admin/users/${b.dataset.reset}/password`, { password: pw });
      toast('パスワードを再発行しました');
    })));
  appEl.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', withErrors(async () => {
      if (!confirm(`${b.dataset.name} のアカウントを削除します。よろしいですか？`)) return;
      await api('DELETE', `/api/admin/users/${b.dataset.del}`);
      renderAdmin();
    })));
}

// ---------------------------------------------------------------- 保護者（ログイン不要）

async function renderParent(params) {
  const month = params.get('month') || todayStr().slice(0, 7);
  const school = params.get('school') || '';
  const code = params.get('code') || '';
  try {
    const data = await api('GET', `/api/public/schools/${encodeURIComponent(school)}?code=${encodeURIComponent(code)}&month=${month}`);
    const go = (m) => {
      const p = new URLSearchParams(params);
      p.set('month', m);
      history.replaceState(null, '', `?${p}`);
      renderParent(p);
    };
    const today = todayStr();
    const dates = monthDates(month).filter((d) => data.days[d] || (dowOf(d) >= 1 && dowOf(d) <= 5));
    appEl.innerHTML = `
      <h1>${esc(data.school.name)} 下校時刻</h1>
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
          ${day ? day.grades.map((g) => `<td class="time">${esc(timeText(g))}</td>`).join('') + `<td>${esc(day.note)}</td>` : `<td colspan="${GRADES + 1}" class="muted">未定</td>`}</tr>`;
      }).join('')}</tbody></table></div>
      <p class="muted">最新の情報は学校が公開した時点で自動的に反映されます。<br>防犯のため、このページのリンクは学校関係者以外に教えないでください。</p>`;
    appEl.querySelector('#prev').addEventListener('click', () => go(shiftMonth(month, -1)));
    appEl.querySelector('#next').addEventListener('click', () => go(shiftMonth(month, 1)));
    appEl.querySelector('#print').addEventListener('click', () => window.print());
  } catch (err) {
    appEl.innerHTML = `<div class="card">${esc(err.message)}</div>`;
  }
}

boot();
