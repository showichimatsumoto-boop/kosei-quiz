/* 個性心理學® 七夕支局 結業測驗
 *
 * このファイルは「器」だけを担う。問題文・選択肢・解説は Google スプレッドシート（Apps Script 経由）、
 * UI 文言は ui.json、Apps Script の URL は config.json に置き、ここには用語を一切書かない。
 * 問題は公開リポジトリに置かず、QR Code の URL に入った鍵（#k=...）が合ったときだけ取得できる。
 * 通信は自サイトの JSON の fetch と、config.endpoint（Google Apps Script）との送受信のみ。
 */

'use strict';

var QUESTION_COUNT = 15;
var MINUTES = 5;
var LAYERS = ['say', 'distinguish', 'use'];
var OPTION_COUNT = 4;

var app = document.getElementById('app');
var course = document.body.getAttribute('data-course');
var key = (window.location.hash.match(/[#&]k=([^&]+)/) || [])[1] || '';
var t = null;          // ui.json
var config = null;     // config.json
var quizData = null;   // Apps Script から受け取った問題データ
var items = [];        // 今回出題する設問（順番・選択肢ともシャッフル済み）
var index = 0;         // 現在の設問番号（0始まり）
var picked = null;     // 現在の設問で選択中の選択肢 id

// 受講者情報と回数。リロードすると消える（新しいセッションになる）。
var learner = { date: '', instructor: '', name: '' };
var sessionId = '';
var attempt = 0;

/* ---------- utilities ---------- */

function fmt(template, values) {
  return template.replace(/\{(\w+)\}/g, function (_, key) {
    return values[key];
  });
}

function el(tag, className, text) {
  var node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function clear() {
  while (app.firstChild) app.removeChild(app.firstChild);
}

function shuffled(array) {
  var copy = array.slice();
  for (var i = copy.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var tmp = copy[i];
    copy[i] = copy[j];
    copy[j] = tmp;
  }
  return copy;
}

function getJSON(path) {
  return fetch(path, { cache: 'no-cache' }).then(function (response) {
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return response.json();
  });
}

function today() {
  var d = new Date();
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function newSessionId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

/* ---------- validation ---------- */

/* 本番前の検証用。問題があれば理由の一覧を返す（空なら OK）。
   draw があれば「層ごとに何問出すか」、なければ全問をそのまま出題する。 */
function validate(data) {
  var errors = [];
  var qs = data && data.questions;

  if (!Array.isArray(qs)) return ['questions'];

  if (data.draw) {
    var drawTotal = 0;
    LAYERS.forEach(function (layer) {
      var want = data.draw[layer] || 0;
      var have = qs.filter(function (q) { return q.layer === layer; }).length;
      drawTotal += want;
      if (have < want) errors.push('draw.' + layer + ': ' + have + ' < ' + want);
    });
    if (drawTotal !== QUESTION_COUNT) errors.push('draw: ' + drawTotal + ' / ' + QUESTION_COUNT);
  } else if (qs.length !== QUESTION_COUNT) {
    errors.push('questions: ' + qs.length + ' / ' + QUESTION_COUNT);
  }

  var seen = {};
  qs.forEach(function (q, i) {
    var label = (q && q.id) || ('#' + (i + 1));
    var options = Array.isArray(q.options) ? q.options : [];
    var ids = options.map(function (o) { return o.id; });

    if (!q.id || seen[q.id]) errors.push(label + ': id');
    seen[q.id] = true;
    if (!q.prompt) errors.push(label + ': prompt');
    if (LAYERS.indexOf(q.layer) === -1) errors.push(label + ': layer "' + q.layer + '"');
    if (options.length !== OPTION_COUNT) errors.push(label + ': options ' + options.length + ' / ' + OPTION_COUNT);
    if (ids.some(function (id, j) { return !id || ids.indexOf(id) !== j; })) errors.push(label + ': option id');
    if (options.some(function (o) { return !o.text; })) errors.push(label + ': option text');
    if (ids.indexOf(q.answer) === -1) errors.push(label + ': answer "' + q.answer + '"');
    if (!q.explanation) errors.push(label + ': explanation');

    var misconceptions = options.filter(function (o) { return o.misconception === true; });
    if (q.layer === 'use' && misconceptions.length !== 1) {
      errors.push(label + ': misconception ' + misconceptions.length + ' / 1');
    }
    if (misconceptions.some(function (o) { return o.id === q.answer; })) {
      errors.push(label + ': misconception = answer');
    }
  });

  return errors;
}

/* ---------- setup ---------- */

/* 今回出題する設問を選ぶ。draw があれば層ごとに指定数をランダムに選ぶ。 */
function pickQuestions(data) {
  if (!data.draw) return data.questions.slice();
  var chosen = [];
  LAYERS.forEach(function (layer) {
    var pool = data.questions.filter(function (q) { return q.layer === layer; });
    chosen = chosen.concat(shuffled(pool).slice(0, data.draw[layer] || 0));
  });
  return chosen;
}

/* 出題用の形に整える。出題順・選択肢とも毎回シャッフルする。 */
function buildItems(questions) {
  return shuffled(questions).map(function (q) {
    return {
      id: q.id,
      prompt: q.prompt,
      layer: q.layer,
      answer: q.answer,
      explanation: q.explanation,
      misconceptionNote: q.misconceptionNote,
      options: shuffled(q.options),
      picked: null
    };
  });
}

function optionById(item, id) {
  for (var i = 0; i < item.options.length; i++) {
    if (item.options[i].id === id) return item.options[i];
  }
  return null;
}

function startAttempt() {
  attempt += 1;
  items = buildItems(pickQuestions(quizData));
  index = 0;
  renderQuestion();
}

/* ---------- sending ---------- */

/* 1回分の結果を Google Apps Script に送る。
   Content-Type を text/plain にして CORS のプリフライトを避ける。 */
function sendResult(result, status) {
  status.className = 'send-status';
  status.textContent = t.sending;

  fetch(config.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(result)
  })
    .then(function (response) { return response.json(); })
    .then(function (body) {
      if (!body || body.ok !== true) throw new Error('rejected');
      status.className = 'send-status is-sent';
      status.textContent = t.sent;
    })
    .catch(function () {
      status.className = 'send-status is-failed';
      status.textContent = t.sendFailed + ' ';
      var again = el('button', 'link-button', t.resend);
      again.type = 'button';
      again.addEventListener('click', function () { sendResult(result, status); });
      status.appendChild(again);
    });
}

function buildResult(correctCount, layerScores) {
  return {
    course: course,
    key: key,
    version: quizData.version || '',
    sessionId: sessionId,
    date: learner.date,
    instructor: learner.instructor,
    name: learner.name,
    attempt: attempt,
    score: correctCount,
    total: items.length,
    say: layerScores.say || '',
    distinguish: layerScores.distinguish || '',
    use: layerScores.use || '',
    wrong: items.filter(function (item) { return item.picked !== item.answer; })
      .map(function (item) { return item.id; }).join(','),
    questions: items.map(function (item) { return item.id; }).join(',')
  };
}

/* ---------- screens ---------- */

function field(labelText, control) {
  var wrapper = el('label', 'field');
  wrapper.appendChild(el('span', 'field-label', labelText));
  wrapper.appendChild(control);
  return wrapper;
}

function renderEntry() {
  clear();

  var card = el('section', 'card stack');
  card.appendChild(el('h1', 'start-title', quizData.title));
  card.appendChild(el('p', 'meta',
    fmt(t.questionCount, { n: QUESTION_COUNT }) + '・' + fmt(t.duration, { m: MINUTES })));

  var date = el('input', 'input');
  date.type = 'date';
  date.value = learner.date || today();
  card.appendChild(field(t.dateLabel, date));

  var instructor = el('input', 'input');
  instructor.type = 'text';
  instructor.maxLength = 50;
  instructor.placeholder = t.instructorPlaceholder;
  instructor.value = learner.instructor;
  card.appendChild(field(t.instructorLabel, instructor));

  var name = el('input', 'input');
  name.type = 'text';
  name.autocomplete = 'name';
  name.maxLength = 50;
  name.placeholder = t.namePlaceholder;
  name.value = learner.name;
  card.appendChild(field(t.nameLabel, name));

  card.appendChild(el('p', 'privacy', t.privacyNote));

  var consentBox = el('input');
  consentBox.type = 'checkbox';
  var consent = el('label', 'consent');
  consent.appendChild(consentBox);
  consent.appendChild(el('span', null, t.consent));
  card.appendChild(consent);

  var button = el('button', 'btn btn-primary', t.start);
  button.type = 'button';
  button.disabled = true;
  card.appendChild(button);

  function update() {
    button.disabled = !(date.value && instructor.value.trim() && name.value.trim() && consentBox.checked);
  }
  [date, instructor, name, consentBox].forEach(function (control) {
    control.addEventListener('input', update);
    control.addEventListener('change', update);
  });

  button.addEventListener('click', function () {
    learner = { date: date.value, instructor: instructor.value.trim(), name: name.value.trim() };
    sessionId = newSessionId();
    attempt = 0;
    startAttempt();
  });

  app.appendChild(card);
  window.scrollTo(0, 0);
}

function renderQuestion() {
  clear();
  picked = null;

  var item = items[index];
  var total = items.length;

  var progress = el('div', 'progress');
  progress.appendChild(el('p', 'progress-text', fmt(t.progress, { i: index + 1, n: total })));
  var bar = el('div', 'progress-bar');
  var fill = el('span', 'progress-fill');
  fill.style.width = ((index + 1) / total * 100) + '%';
  bar.appendChild(fill);
  progress.appendChild(bar);

  var card = el('section', 'card');
  card.appendChild(el('h1', 'question', item.prompt));

  var list = el('ul', 'choices');
  list.setAttribute('role', 'radiogroup');
  list.setAttribute('aria-label', item.prompt);
  var buttons = [];

  var next = el('button', 'btn btn-primary', index === total - 1 ? t.finish : t.next);
  next.type = 'button';
  next.disabled = true;

  // 未選択のあいだは「下一題」を無効にし、代わりに案内文を出す
  var hint = el('p', 'meta', t.selectPrompt);

  item.options.forEach(function (option) {
    var button = el('button', 'choice');
    button.type = 'button';
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', 'false');
    button.appendChild(el('span', 'choice-mark'));
    button.appendChild(el('span', null, option.text));

    button.addEventListener('click', function () {
      picked = option.id;
      buttons.forEach(function (other) {
        other.setAttribute('aria-checked', other === button ? 'true' : 'false');
      });
      next.disabled = false;
      hint.hidden = true;
    });

    buttons.push(button);
    var li = document.createElement('li');
    li.appendChild(button);
    list.appendChild(li);
  });
  card.appendChild(list);

  next.addEventListener('click', function () {
    if (picked === null) return;
    item.picked = picked;
    index += 1;
    if (index >= total) renderResult();
    else renderQuestion();
  });

  card.appendChild(next);
  card.appendChild(hint);

  app.appendChild(progress);
  app.appendChild(card);
  window.scrollTo(0, 0);
}

function renderResult() {
  clear();

  var correctCount = items.filter(function (item) { return item.picked === item.answer; }).length;
  var percent = Math.round(correctCount / items.length * 100);
  var perfect = correctCount === items.length;

  var card = el('section', 'card score-card');
  if (perfect) {
    card.appendChild(el('p', 'complete-title', t.completeTitle));
    var who = el('p', 'complete-who');
    who.appendChild(el('span', 'complete-name', learner.name));
    who.appendChild(el('span', null, learner.instructor + '・' + learner.date));
    card.appendChild(who);
  }
  card.appendChild(el('p', 'score-label', t.scoreLabel + '・' + fmt(t.attempt, { n: attempt })));

  var score = el('p', 'score-value', String(correctCount));
  score.appendChild(el('span', 'score-total', ' / ' + items.length));
  card.appendChild(score);
  card.appendChild(el('p', 'score-percent', fmt(t.percent, { p: percent })));

  // 層別の内訳（その層の設問がない場合は出さない）
  var layerScores = {};
  var layers = el('ul', 'layers');
  LAYERS.forEach(function (layer) {
    var inLayer = items.filter(function (item) { return item.layer === layer; });
    if (inLayer.length === 0) return;
    var ok = inLayer.filter(function (item) { return item.picked === item.answer; }).length;
    layerScores[layer] = ok + '/' + inLayer.length;
    var li = el('li', 'layer');
    li.appendChild(el('span', 'layer-name', t.layers[layer]));
    li.appendChild(el('span', 'layer-value', layerScores[layer]));
    layers.appendChild(li);
  });
  card.appendChild(layers);

  card.appendChild(el('p', 'score-note', perfect ? t.completeLead : t.retryLead));

  var status = el('p', 'send-status');
  card.appendChild(status);
  app.appendChild(card);

  sendResult(buildResult(correctCount, layerScores), status);

  if (!perfect) {
    app.appendChild(el('h2', 'section-title', t.reviewTitle));

    var list = el('ul', 'review');
    items.forEach(function (item, i) {
      if (item.picked === item.answer) return;
      var mine = optionById(item, item.picked);

      var review = el('article', 'card review-card');
      var head = el('p', 'review-question');
      head.appendChild(el('span', 'review-number', 'Q' + (i + 1)));
      head.appendChild(document.createTextNode(item.prompt));
      review.appendChild(head);

      review.appendChild(row(t.yourAnswer, mine.text, 'review-mine'));
      review.appendChild(row(t.correctAnswer, optionById(item, item.answer).text, 'review-correct'));
      review.appendChild(note(t.explanation, item.explanation));

      if (mine.misconception === true && item.misconceptionNote) {
        review.appendChild(note(t.misconceptionNote, item.misconceptionNote));
      }

      var li = document.createElement('li');
      li.appendChild(review);
      list.appendChild(li);
    });
    app.appendChild(list);

    var actions = el('div', 'actions');
    var retry = el('button', 'btn btn-primary', t.retry);
    retry.type = 'button';
    retry.addEventListener('click', startAttempt);
    actions.appendChild(retry);
    app.appendChild(actions);
  }

  window.scrollTo(0, 0);
}

function row(label, text, valueClass) {
  var wrapper = el('div', 'review-row');
  wrapper.appendChild(el('span', 'review-key', label));
  wrapper.appendChild(el('span', valueClass, text));
  return wrapper;
}

function note(label, text) {
  var wrapper = el('p', 'review-explanation');
  wrapper.appendChild(el('span', 'review-note-key', label + '：'));
  wrapper.appendChild(document.createTextNode(text));
  return wrapper;
}

function renderMessage(message, details) {
  clear();
  var notice = el('div', 'notice');
  notice.appendChild(el('p', null, message));
  if (details && details.length) {
    var list = el('ul', 'notice-list');
    details.forEach(function (d) { list.appendChild(el('li', null, d)); });
    notice.appendChild(list);
  }
  app.appendChild(notice);
}

/* ---------- boot ---------- */

(function start() {
  Promise.all([getJSON('../ui.json'), getJSON('../config.json')])
    .then(function (results) {
      t = results[0];
      config = results[1];
      if (!key) throw new Error('no key');
      return getJSON(config.endpoint + '?course=' + encodeURIComponent(course) + '&k=' + encodeURIComponent(key));
    })
    .then(function (body) {
      if (!body || body.ok !== true) throw new Error('bad key');
      quizData = body.data;
      document.title = quizData.title;

      var errors = validate(quizData);
      if (errors.length) {
        renderMessage(t.dataError, errors);
        return;
      }

      renderEntry();
    })
    .catch(function (err) {
      if (t && /key/.test(err.message)) {
        renderMessage(t.needQr);
        return;
      }
      // ui.json 自体が読めない場合もあるので、この1文だけは直書き
      renderMessage((t && t.loadError) || '題目載入失敗，請重新整理頁面。');
    });
})();
