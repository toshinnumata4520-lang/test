'use strict';

// デモ用の初期データ。学校名・学童名・電話番号はすべて架空（サンプル）です。

const DEMO_PASSWORD = 'demo1234';

const SCHOOLS = [
  { loginId: 'school1', name: 'サンプル沼田第一小学校', municipality: '沼田市' },
  { loginId: 'school2', name: 'サンプル沼田第二小学校', municipality: '沼田市' },
  { loginId: 'school3', name: 'サンプル沼田東小学校', municipality: '沼田市' },
  { loginId: 'school4', name: 'サンプルみなかみ小学校', municipality: 'みなかみ町' },
  { loginId: 'school5', name: 'サンプル月夜野小学校', municipality: 'みなかみ町' },
  { loginId: 'school6', name: 'サンプル川場小学校', municipality: '川場村' },
  { loginId: 'school7', name: 'サンプル片品小学校', municipality: '片品村' },
  { loginId: 'school8', name: 'サンプル昭和小学校', municipality: '昭和村' },
];

// approved: 学校が承認済み / pending: 承認待ち（schools のインデックス）
const GAKUDOS = [
  { loginId: 'gakudo1', name: 'サンプル学習塾 学童クラブ', municipality: '沼田市', phone: '0278-00-0001', approved: [0, 1], pending: [] },
  { loginId: 'gakudo2', name: 'サンプル放課後児童クラブ', municipality: '沼田市', phone: '0278-00-0002', approved: [0], pending: [] },
  { loginId: 'gakudo3', name: 'サンプルみなかみ学童', municipality: 'みなかみ町', phone: '0278-00-0003', approved: [3], pending: [0] },
];

// 曜日ごとの標準的な下校時刻（1〜6年）
const STANDARD = {
  1: ['14:45', '14:45', '15:35', '15:35', '15:35', '15:35'], // 月
  2: ['14:45', '14:45', '15:35', '15:35', '15:35', '15:35'], // 火
  3: ['13:45', '13:45', '13:45', '13:45', '14:40', '14:40'], // 水
  4: ['14:45', '14:45', '15:35', '15:35', '15:35', '15:35'], // 木
  5: ['14:45', '14:45', '14:45', '15:35', '15:35', '15:35'], // 金
};

function monthDays(year, month) {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const days = [];
  for (let d = 1; d <= last; d++) {
    const date = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    days.push({ date, dow: new Date(Date.UTC(year, month - 1, d)).getUTCDay() });
  }
  return days;
}

function jstYearMonth(now) {
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  return { year: jst.getUTCFullYear(), month: jst.getUTCMonth() + 1 };
}

function seed(store) {
  const admin = store.createOrg({ type: 'admin', name: '利根沼田 下校時刻共有 運営事務局', municipality: '' });
  store.createUser({ orgId: admin.id, loginId: 'admin', name: '運営事務局', password: DEMO_PASSWORD });

  const schools = SCHOOLS.map((s) => {
    const org = store.createOrg({ type: 'school', name: s.name, municipality: s.municipality });
    store.createUser({ orgId: org.id, loginId: s.loginId, name: `${s.name} 教務主任`, password: DEMO_PASSWORD });
    return org;
  });
  const schoolUser = (school) => store.data.users.find((u) => u.orgId === school.id);

  for (const g of GAKUDOS) {
    const org = store.createOrg({ type: 'gakudo', name: g.name, municipality: g.municipality, phone: g.phone });
    store.createUser({ orgId: org.id, loginId: g.loginId, name: `${g.name} 職員`, password: DEMO_PASSWORD });
    for (const i of g.approved) {
      const link = store.requestLink(org.id, schools[i].id);
      store.decideLink(schools[i].id, link.id, true, schoolUser(schools[i]).id);
    }
    for (const i of g.pending) store.requestLink(org.id, schools[i].id);
  }

  // 最初の 2 校は今月分の下校時刻を公開済みにしておく
  const { year, month } = jstYearMonth(store.now());
  for (const school of schools.slice(0, 2)) {
    const days = {};
    for (const { date, dow } of monthDays(year, month)) {
      if (STANDARD[dow]) days[date] = { grades: STANDARD[dow], note: '' };
    }
    store.saveDrafts(school.id, days);
    store.publish(school.id, schoolUser(school).id, `${month}月の下校予定です。よろしくお願いします。`);
  }
}

module.exports = { seed, DEMO_PASSWORD, STANDARD, monthDays };
