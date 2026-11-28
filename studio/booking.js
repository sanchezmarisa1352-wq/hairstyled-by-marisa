import {appointmentControls, localDay} from './client.js';

const $ = id => document.getElementById(id);
const today = localDay();
const limit = new Date(today + 'T12:00:00Z');
limit.setUTCDate(limit.getUTCDate() + 90);
const lastDay = limit.toISOString().slice(0, 10);
const month = new Date(today.slice(0, 7) + '-01T12:00:00Z');
let chosen = '';
const refresh = appointmentControls({
  date: () => chosen,
  time: $('appointment-time'),
  form: $('appointment-form'),
  submit: $('reserve'),
  status: $('booking-message'),
  availability: $('slot-message'),
  selection: () => Object.fromEntries([...picks].map(([item, count]) => [item.name, count]))
});

function draw(focusDate) {
  $('month').textContent = month.toLocaleDateString('en-US', {month:'long', year:'numeric', timeZone:'UTC'});
  $('prev').disabled = month.toISOString().slice(0, 7) <= today.slice(0, 7);
  $('next').disabled = month.toISOString().slice(0, 7) >= lastDay.slice(0, 7);
  const cal = $('calendar');
  cal.replaceChildren();
  for (const day of ['S','M','T','W','T','F','S']) {
    const span = document.createElement('span');
    span.textContent = day;
    cal.append(span);
  }
  for (let i = 0; i < month.getUTCDay(); i++) cal.append(document.createElement('span'));
  const date = new Date(month);
  while (date.getUTCMonth() === month.getUTCMonth()) {
    const iso = date.toISOString().slice(0, 10);
    const b = document.createElement('button');
    const label = date.toLocaleDateString('en-US', {dateStyle:'full',timeZone:'UTC'});
    b.textContent = date.getUTCDate();
    b.disabled = iso < today || iso > lastDay || [0,4].includes(date.getUTCDay());
    b.setAttribute('aria-label', label);
    b.setAttribute('aria-pressed', String(chosen === iso));
    b.className = chosen === iso ? 'chosen' : '';
    b.onclick = () => {
      chosen = iso;
      $('selected').textContent = label;
      draw(iso);
      refresh();
    };
    cal.append(b);
    if (focusDate === iso) b.focus();
    date.setUTCDate(date.getUTCDate() + 1);
  }
}
$('prev').onclick = () => { month.setUTCMonth(month.getUTCMonth() - 1); draw(); };
$('next').onclick = () => { month.setUTCMonth(month.getUTCMonth() + 1); draw(); };
document.addEventListener('studio:selection', refresh);
draw();
