/* Shared UI helpers for calorie-tracker (calendar, icons, dishes, comments). */

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
  });
}

var NAME_ICONS = {
  'морков': '🥕', 'яблок': '🍎', 'банан': '🍌', 'огурец': '🥒',
  'помидор': '🍅', 'картош': '🥔', 'лук': '🧅', 'чеснок': '🧄',
  'яйц': '🥚', 'хлеб': '🍞', 'сыр': '🧀', 'творог': '🧀',
  'молок': '🥛', 'куриц': '🍗', 'рыб': '🐟', 'мяс': '🥩',
  'свинин': '🥩', 'говяд': '🥩', 'рис': '🍚', 'греч': '🍚',
  'овс': '🥣', 'масл': '🧈', 'шоколад': '🍫', 'конфет': '🍬',
  'ягод': '🍓', 'клубник': '🍓', 'авокад': '🥑', 'броккол': '🥦',
  'салат': '🥗', 'тунец': '🍣', 'кревет': '🦀', 'кофе': '☕'
};
var CATEGORY_ICONS = {
  'Молочные': '🧀', 'Выпечка': '🍞', 'Мясо и рыба': '🍗',
  'Овощи': '🥦', 'Фрукты и ягоды': '🍎', 'Крупы': '🌾',
  'Сладости': '🍫', 'Домашнее': '🏠', 'Другое': '📦', 'Масло': '🧈'
};
var FOOD_EMOJI = ['🥗','🥦','🍎','🍌','🥑','🧀','🥚','🍞','🍗','🥩','🐟','🍚','🥣','🧈','🥛','🍅','🥕','🍓','🍫','☕','🍣','🥔','🧅','🧄','🥒','🥜','🍋','🍊','🍇','🍉','🍯','🌮','🍲','🥘','🍜','🌯','🍕','🍰','🍦','🍵'];
var DISH_EMOJI = ['🍽️','🥣','🍲','🥘','🍴','🥄','🫖','🥛','🍶','🥡','🍱','🥗','☕','🍵','🥃','🧁','🫙','🫕'];

function defaultFoodIcon(name, category) {
  var n = (name || '').toLowerCase();
  var key;
  for (key in NAME_ICONS) {
    if (n.indexOf(key) !== -1) return NAME_ICONS[key];
  }
  return CATEGORY_ICONS[category] || '🥗';
}

function productIcon(p) {
  if (!p) return '🥗';
  if (p.emoji) return p.emoji;
  return defaultFoodIcon(p.name, p.category);
}

function loadDishes() {
  try {
    var raw = JSON.parse(localStorage.getItem('dishes') || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch (e) { return []; }
}

function saveDishes(list) {
  localStorage.setItem('dishes', JSON.stringify(list));
}

var WEEKDAYS_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
var MONTHS_GEN = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
var MONTHS_NOM = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
var WEEKDAYS_CAL = ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];

function weekdayShort(date) {
  return WEEKDAYS_SHORT[date.getDay()];
}

function formatDayMonthWeekday(dateStr) {
  var parts = String(dateStr || '').split('-');
  if (parts.length !== 3) return dateStr || '';
  var d = new Date(+parts[0], +parts[1] - 1, +parts[2]);
  if (isNaN(d.getTime())) return dateStr;
  var dd = String(d.getDate()).padStart(2, '0');
  var mm = String(d.getMonth() + 1).padStart(2, '0');
  return weekdayShort(d) + ', ' + dd + '.' + mm;
}

function parseISODate(str) {
  if (!str) return null;
  var p = String(str).split('-');
  if (p.length !== 3) return null;
  var d = new Date(+p[0], +p[1] - 1, +p[2]);
  return isNaN(d.getTime()) ? null : d;
}

/* Mini month calendar. container is an element. selected is Date or YYYY-MM-DD.
   onSelect(dateStr, dateObj). */
function renderMiniCalendar(container, selected, onSelect) {
  if (!container) return;
  var sel = (selected instanceof Date) ? selected : (parseISODate(selected) || new Date());
  if (!container._calYear) {
    container._calYear = sel.getFullYear();
    container._calMonth = sel.getMonth();
  }
  var year = container._calYear;
  var month = container._calMonth;
  var selStr = localDateStr(sel);
  var todayStr = localDateStr(new Date());

  var html = '<div class="mini-cal">';
  html += '<div class="mini-cal-head">';
  html += '<button type="button" class="arrow mini-cal-prev" aria-label="Предыдущий месяц"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 6.5 9 12l5.5 5.5"/></svg></button>';
  html += '<div class="mini-cal-title">' + MONTHS_NOM[month] + ' ' + year + '</div>';
  html += '<button type="button" class="arrow mini-cal-next" aria-label="Следующий месяц"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 6.5 15 12l-5.5 5.5"/></svg></button>';
  html += '</div><div class="cal-grid mini-cal-grid">';
  WEEKDAYS_CAL.forEach(function (d) {
    html += '<div class="cal-weekday">' + d + '</div>';
  });
  var first = new Date(year, month, 1);
  var start = first.getDay() - 1;
  if (start < 0) start = 6;
  var daysInMonth = new Date(year, month + 1, 0).getDate();
  var i, d, ds;
  for (i = 0; i < start; i++) html += '<div class="cal-day other"></div>';
  for (d = 1; d <= daysInMonth; d++) {
    ds = localDateYMD(year, month, d);
    var cls = 'cal-day';
    if (ds === todayStr) cls += ' today';
    if (ds === selStr) cls += ' selected';
    html += '<button type="button" class="' + cls + '" data-date="' + ds + '">' + d + '</button>';
  }
  html += '</div></div>';
  container.innerHTML = html;

  container.querySelector('.mini-cal-prev').onclick = function () {
    container._calMonth--;
    if (container._calMonth < 0) { container._calMonth = 11; container._calYear--; }
    renderMiniCalendar(container, selected, onSelect);
  };
  container.querySelector('.mini-cal-next').onclick = function () {
    container._calMonth++;
    if (container._calMonth > 11) { container._calMonth = 0; container._calYear++; }
    renderMiniCalendar(container, selected, onSelect);
  };
  container.querySelectorAll('.cal-day[data-date]').forEach(function (btn) {
    btn.onclick = function () {
      var dateStr = btn.getAttribute('data-date');
      var parts = dateStr.split('-');
      var dateObj = new Date(+parts[0], +parts[1] - 1, +parts[2]);
      if (typeof onSelect === 'function') onSelect(dateStr, dateObj);
    };
  });
}

function renderEmojiPicker(container, current, palette, onPick) {
  if (!container) return;
  var list = palette && palette.length ? palette : FOOD_EMOJI;
  var html = '<div class="emoji-picker">';
  list.forEach(function (em) {
    html += '<button type="button" class="emoji-opt' + (em === current ? ' selected' : '') + '" data-emoji="' + escapeHtml(em) + '">' + em + '</button>';
  });
  html += '</div>';
  container.innerHTML = html;
  container.querySelectorAll('.emoji-opt').forEach(function (btn) {
    btn.onclick = function (e) {
      e.preventDefault();
      var em = btn.getAttribute('data-emoji');
      if (typeof onPick === 'function') onPick(em);
    };
  });
}

function commentBlock(text, key) {
  var c = (text || '').trim();
  if (!c) return '';
  var id = 'cmt-' + (key || Math.random().toString(36).slice(2));
  var long = c.length > 60 || c.indexOf('\n') !== -1;
  if (!long) {
    return '<div class="w-comment">' + escapeHtml(c) + '</div>';
  }
  return '<div class="w-comment-wrap" id="' + id + '">' +
    '<div class="w-comment is-clamp">' + escapeHtml(c) + '</div>' +
    '<button type="button" class="w-comment-toggle" onclick="toggleComment(\'' + id + '\')" aria-label="Показать комментарий">▾</button>' +
    '</div>';
}

function toggleComment(id) {
  var wrap = document.getElementById(id);
  if (!wrap) return;
  var open = wrap.classList.toggle('is-open');
  var c = wrap.querySelector('.w-comment');
  var btn = wrap.querySelector('.w-comment-toggle');
  if (c) c.classList.toggle('is-clamp', !open);
  if (btn) btn.textContent = open ? '▴' : '▾';
}

/* Mount a "subtract dish weight" control.
   opts: { gramsGetter, gramsSetter, label }
   gramsGetter() -> number entered, gramsSetter(net, {dish, raw}) used only for preview callback
   Returns { getNetGrams, reset }
*/
function mountDishSubtract(container, opts) {
  opts = opts || {};
  if (!container) return { getNetGrams: function (raw) { return raw; }, reset: function () {} };
  var dishes = loadDishes();
  var html = '<label class="dish-sub-row"><input type="checkbox" class="dish-sub-on"> Отнять вес посуды</label>';
  html += '<div class="dish-sub-pick" hidden>';
  if (!dishes.length) {
    html += '<div class="dish-sub-empty">Сначала добавьте посуду во вкладке «Моя посуда».</div>';
  } else {
    html += '<select class="dish-sub-select">';
    html += '<option value="">Выберите посуду</option>';
    dishes.forEach(function (d) {
      html += '<option value="' + d.id + '">' + escapeHtml((d.emoji || '🍽️') + ' ' + d.name + ' · ' + d.weight + ' г') + '</option>';
    });
    html += '</select>';
  }
  html += '<div class="dish-sub-preview"></div></div>';
  container.innerHTML = html;
  container.hidden = false;

  var chk = container.querySelector('.dish-sub-on');
  var pick = container.querySelector('.dish-sub-pick');
  var sel = container.querySelector('.dish-sub-select');
  var prev = container.querySelector('.dish-sub-preview');

  function selectedDish() {
    if (!chk.checked || !sel || !sel.value) return null;
    var id = +sel.value;
    for (var i = 0; i < dishes.length; i++) if (dishes[i].id === id) return dishes[i];
    return null;
  }

  function rawGrams() {
    if (typeof opts.gramsGetter === 'function') return +opts.gramsGetter() || 0;
    return 0;
  }

  function update() {
    pick.hidden = !chk.checked;
    var dish = selectedDish();
    var raw = rawGrams();
    if (!chk.checked) {
      prev.textContent = '';
      if (typeof opts.onChange === 'function') opts.onChange(raw, { raw: raw, dish: null, net: raw });
      return;
    }
    if (!dish) {
      prev.textContent = '';
      if (typeof opts.onChange === 'function') opts.onChange(raw, { raw: raw, dish: null, net: raw });
      return;
    }
    var net = Math.round((raw - (+dish.weight || 0)) * 10) / 10;
    if (net <= 0) {
      prev.innerHTML = '<span class="dish-sub-warn">После вычета получается ' + String(net).replace('.', ',') + ' г. Проверьте вес.</span>';
    } else {
      prev.textContent = 'К занесению: ' + String(net).replace('.', ',') + ' г (минус ' + dish.weight + ' г)';
    }
    if (typeof opts.onChange === 'function') opts.onChange(net, { raw: raw, dish: dish, net: net });
  }

  chk.onchange = update;
  if (sel) sel.onchange = update;
  container._dishUpdate = update;

  return {
    getNetGrams: function (raw) {
      var r = (raw != null) ? +raw : rawGrams();
      if (!chk.checked) return r;
      var dish = selectedDish();
      if (!dish) return r;
      return Math.round((r - (+dish.weight || 0)) * 10) / 10;
    },
    isOn: function () { return !!chk.checked; },
    selectedDish: selectedDish,
    update: update,
    reset: function () {
      chk.checked = false;
      if (sel) sel.value = '';
      update();
    }
  };
}

function netGramsOrAlert(ctrl, raw) {
  var net = ctrl ? ctrl.getNetGrams(raw) : raw;
  if (ctrl && ctrl.isOn() && !ctrl.selectedDish()) {
    alert('Выберите посуду или снимите галочку.');
    return null;
  }
  if (!(net > 0)) {
    alert('Вес после вычета посуды должен быть больше нуля.');
    return null;
  }
  return net;
}
