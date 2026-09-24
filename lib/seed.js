'use strict';

// デモ用の初期データ。組織名・学校名・学童名・電話番号はすべて架空（サンプル）です。
//
// 管理体制（案）
//   連絡協議会（全体の管理。事務局は幹事市町村の教育委員会を想定）
//     └ 市町村の管理者（教育委員会・学童担当課）… 自分の市町村の学校・学童だけを管理
//         └ 学校・学童の管理職 … 自組織の職員アカウントを管理（人事異動への対応）

const DEMO_PASSWORD = 'demo1234';

const BOARDS = [
  { loginId: 'numata-boe', name: '沼田市教育委員会（サンプル）', municipality: '沼田市', manages: ['school'] },
  { loginId: 'numata-kodomo', name: '沼田市 学童担当課（サンプル）', municipality: '沼田市', manages: ['gakudo'] },
  { loginId: 'minakami-boe', name: 'みなかみ町教育委員会（サンプル）', municipality: 'みなかみ町', manages: ['school', 'gakudo'] },
  { loginId: 'kawaba-boe', name: '川場村教育委員会（サンプル）', municipality: '川場村', manages: ['school', 'gakudo'] },
  { loginId: 'katashina-boe', name: '片品村教育委員会（サンプル）', municipality: '片品村', manages: ['school', 'gakudo'] },
  { loginId: 'showa-boe', name: '昭和村教育委員会（サンプル）', municipality: '昭和村', manages: ['school', 'gakudo'] },
];

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

// approved: 学校が承認済み / pending: 承認待ち（SCHOOLS のインデックス）
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
// 2校目は少しずらす（学童の「お迎え順の一覧」が分かりやすいように）
const STANDARD_B = {
  1: ['14:50', '14:50', '15:40', '15:40', '15:40', '15:40'],
  2: ['14:50', '14:50', '15:40', '15:40', '15:40', '15:40'],
  3: ['13:50', '13:50', '13:50', '13:50', '14:45', '14:45'],
  4: ['14:50', '14:50', '15:40', '15:40', '15:40', '15:40'],
  5: ['14:50', '14:50', '14:50', '15:40', '15:40', '15:40'],
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
  const council = store.createOrg({ type: 'council', name: '利根沼田 下校時刻共有 連絡協議会（サンプル）', municipality: '' });
  store.createUser({ orgId: council.id, loginId: 'council', name: '協議会事務局 担当者', password: DEMO_PASSWORD, role: 'manager' });

  for (const b of BOARDS) {
    const org = store.createOrg({ type: 'board', name: b.name, municipality: b.municipality, manages: b.manages });
    store.createUser({ orgId: org.id, loginId: b.loginId, name: `${b.name} 担当者`, password: DEMO_PASSWORD, role: 'manager' });
  }

  const schools = SCHOOLS.map((s) => {
    const org = store.createOrg({ type: 'school', name: s.name, municipality: s.municipality });
    store.createUser({ orgId: org.id, loginId: s.loginId, name: `${s.name} 教頭`, password: DEMO_PASSWORD, role: 'manager' });
    return org;
  });
  // 1校目には一般の職員アカウントも用意（管理職との権限の違いを確認できるように）
  store.createUser({ orgId: schools[0].id, loginId: 'school1-staff', name: 'サンプル沼田第一小学校 教務担当', password: DEMO_PASSWORD, role: 'staff' });
  const schoolUser = (school) => store.data.users.find((u) => u.orgId === school.id);

  for (const g of GAKUDOS) {
    const org = store.createOrg({ type: 'gakudo', name: g.name, municipality: g.municipality, phone: g.phone });
    store.createUser({ orgId: org.id, loginId: g.loginId, name: `${g.name} 施設長`, password: DEMO_PASSWORD, role: 'manager' });
    for (const i of g.approved) {
      const link = store.requestLink(org.id, schools[i].id);
      store.decideLink(schools[i].id, link.id, true, schoolUser(schools[i]).id);
    }
    for (const i of g.pending) store.requestLink(org.id, schools[i].id);
  }

  // 最初の 2 校は今月分の下校時刻を公開済みにしておく
  const { year, month } = jstYearMonth(store.now());
  for (const [i, school] of schools.slice(0, 2).entries()) {
    const pattern = i === 0 ? STANDARD : STANDARD_B;
    const days = {};
    for (const { date, dow } of monthDays(year, month)) {
      if (pattern[dow]) days[date] = { grades: pattern[dow], note: '' };
    }
    store.saveDrafts(school.id, days);
    store.publish(school.id, schoolUser(school).id, `${month}月の下校予定です。よろしくお願いします。`);
  }
}

module.exports = { seed, DEMO_PASSWORD, STANDARD, monthDays };
