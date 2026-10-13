/* 個性心理學® 七夕支局 結業測驗 — Google Apps Script
 *
 * スプレッドシートの「拡張機能 → Apps Script」にこのファイルの中身を貼り付けて使う
 * （手順は README の「スプレッドシートの設定」）。
 *
 * - 問題は「問題」シート、講座ごとの設定と鍵は「設定」シートに置く。GitHub には置かない。
 * - doGet: 鍵が合えば、その講座の問題を返す（テストページが読み込む）
 * - doPost: 鍵が合えば、1回分の結果を「結果」シートに1行追加する
 */

var SITE_URL = 'https://showichimatsumoto-boop.github.io/kosei-quiz/';
var COURSES = ['basic', 'advanced'];
var LETTERS = ['A', 'B', 'C', 'D'];
var LAYER_NAMES = { '說得出': 'say', '分得出': 'distinguish', '用法': 'use' };

var SETTINGS_HEADER = ['課程', '標題', '版本', '說得出', '分得出', '用法', '鍵', 'QR Code 用 URL'];
var QUESTIONS_HEADER = ['課程', 'id', '層', '問題', '選項A', '選項B', '選項C', '選項D', '正解', '誤解選項', '說明', '補充'];
var RESULT_COLUMNS = [
  ['receivedAt', '受信日時'],
  ['course', '課程'],
  ['date', '上課日期'],
  ['instructor', '授課講師'],
  ['name', '姓名'],
  ['attempt', '回数'],
  ['score', '得点'],
  ['total', '問題数'],
  ['perfect', '満点'],
  ['say', '說得出'],
  ['distinguish', '分得出'],
  ['use', '用法'],
  ['wrong', '誤答した問題'],
  ['questions', '出題した問題'],
  ['sessionId', 'セッションID'],
  ['version', '問題版']
];

/* ---------- 初回だけエディタから実行する ---------- */

/* 「設定」「問題」「結果」シートを作り、講座ごとの鍵と QR Code 用 URL を発行する。
   すでにあるシートには触らないので、何度実行しても既存のデータは消えない。 */
function setup() {
  var book = SpreadsheetApp.getActiveSpreadsheet();

  if (!book.getSheetByName('設定')) {
    var settings = book.insertSheet('設定');
    settings.appendRow(SETTINGS_HEADER);
    settings.appendRow(['basic', '基礎課程 結業測驗', '2026-10', 5, 7, 3, newKey(), '']);
    settings.appendRow(['advanced', '上級課程 結業測驗', '2026-10', '', '', '', newKey(), '']);
    settings.setFrozenRows(1);
  }
  if (!book.getSheetByName('問題')) {
    var questions = book.insertSheet('問題');
    questions.appendRow(QUESTIONS_HEADER);
    questions.setFrozenRows(1);
  }
  getResultSheet();
  refreshQrUrls();
}

/* 鍵を変えたあとに実行すると、QR Code 用 URL を作り直す。 */
function refreshQrUrls() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('設定');
  var rows = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (COURSES.indexOf(rows[i][0]) === -1) continue;
    sheet.getRange(i + 1, 8).setValue(SITE_URL + rows[i][0] + '/#k=' + rows[i][6]);
  }
}

function newKey() {
  return Utilities.getUuid().replace(/-/g, '').slice(0, 16);
}

/* ---------- web app ---------- */

function doGet(e) {
  var course = e.parameter.course;
  var setting = findSetting(course);
  if (!setting || !e.parameter.k || String(e.parameter.k) !== String(setting.key)) {
    return reply({ ok: false, error: 'key' });
  }
  return reply({ ok: true, data: buildQuiz(course, setting) });
}

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var setting = findSetting(data.course);
    if (!setting || String(data.key) !== String(setting.key)) return reply({ ok: false, error: 'key' });
    if (!data.name || !data.instructor) return reply({ ok: false, error: 'invalid' });

    data.receivedAt = new Date();
    data.perfect = Number(data.score) === Number(data.total);

    var lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      getResultSheet().appendRow(RESULT_COLUMNS.map(function (c) { return cell(data[c[0]]); }));
    } finally {
      lock.releaseLock();
    }
    return reply({ ok: true });
  } catch (err) {
    return reply({ ok: false, error: String(err) });
  }
}

/* ---------- helpers ---------- */

function findSetting(course) {
  if (COURSES.indexOf(course) === -1) return null;
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('設定');
  if (!sheet) return null;
  var rows = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (rows[i][0] !== course) continue;
    var draw = null;
    if (rows[i][3] !== '' || rows[i][4] !== '' || rows[i][5] !== '') {
      draw = { say: Number(rows[i][3]) || 0, distinguish: Number(rows[i][4]) || 0, use: Number(rows[i][5]) || 0 };
    }
    return { title: String(rows[i][1]), version: String(rows[i][2]), draw: draw, key: rows[i][6] };
  }
  return null;
}

/* 「問題」シートの行を、テストページが読む形（questions/*.json と同じ形）に組み立てる。
   形式の誤りはテストページ側の検査がエラー一覧として表示する。 */
function buildQuiz(course, setting) {
  var rows = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('問題').getDataRange().getValues();
  var questions = [];
  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    if (r[0] !== course) continue;
    var answer = String(r[8]).trim().toUpperCase();
    var misconception = String(r[9]).trim().toUpperCase();
    var q = {
      id: String(r[1]).trim(),
      layer: LAYER_NAMES[String(r[2]).trim()] || String(r[2]).trim(),
      prompt: String(r[3]),
      options: LETTERS.map(function (letter, j) {
        var option = { id: letter.toLowerCase(), text: String(r[4 + j]) };
        if (misconception === letter) option.misconception = true;
        return option;
      }),
      answer: answer.toLowerCase(),
      explanation: String(r[10])
    };
    if (String(r[11]).trim()) q.misconceptionNote = String(r[11]);
    questions.push(q);
  }
  var quiz = { course: course, title: setting.title, version: setting.version, questions: questions };
  if (setting.draw) quiz.draw = setting.draw;
  return quiz;
}

function getResultSheet() {
  var book = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = book.getSheetByName('結果');
  if (!sheet) {
    sheet = book.insertSheet('結果');
    sheet.appendRow(RESULT_COLUMNS.map(function (c) { return c[1]; }));
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function cell(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return value;
  value = value.slice(0, 200);
  // 「=」などで始まる文字列が数式として解釈されないようにする
  return /^[=+\-@]/.test(value) ? "'" + value : value;
}

function reply(body) {
  return ContentService.createTextOutput(JSON.stringify(body))
    .setMimeType(ContentService.MimeType.JSON);
}
