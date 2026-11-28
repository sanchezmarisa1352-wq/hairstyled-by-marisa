import {localDay} from './client.js';

const $ = id => document.getElementById(id);
const money = new Intl.NumberFormat('en-US', {style:'currency', currency:'USD'});
const dollars = cents => money.format(cents / 100);
const date = day => new Date(day + 'T12:00:00Z');
const iso = day => day.toISOString().slice(0, 10);
const addDays = (day, count) => {
  const result = date(day);
  result.setUTCDate(result.getUTCDate() + count);
  return iso(result);
};
const node = (tag, text) => Object.assign(document.createElement(tag), {textContent:text});

export function periods(today, period) {
  const start = date(today);
  if (period === 'week') start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7);
  else {
    start.setUTCDate(1);
    if (period === 'year') start.setUTCMonth(0);
  }
  const previous = new Date(start);
  if (period === 'week') previous.setUTCDate(previous.getUTCDate() - 7);
  if (period === 'month') previous.setUTCMonth(previous.getUTCMonth() - 1);
  if (period === 'year') previous.setUTCFullYear(previous.getUTCFullYear() - 1);
  return [iso(previous), iso(start)];
}

const commission = visit => Math.round(visit.service_cents * 35 / 100) + Math.round(visit.hair_cents * 10 / 100);

export function summarize(visits) {
  return visits.reduce((totals, visit) => ({
    commission: totals.commission + commission(visit),
    tips: totals.tips + visit.tip_cents
  }), {commission:0, tips:0});
}

function identity(value) {
  const contact = value?.trim().toLowerCase();
  if (!contact) return '';
  if (contact.includes('@')) return contact;
  const digits = contact.replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : contact;
}

export function retention(visits, bookings, today) {
  const upcoming = new Map();
  for (const booking of bookings) {
    const day = localDay(new Date(booking.starts_at));
    for (const key of [identity(booking.email), identity(booking.contact)]) {
      if (key && (!upcoming.has(key) || upcoming.get(key) > day)) upcoming.set(key, day);
    }
  }
  const clients = new Map();
  for (const visit of visits) {
    const contact = identity(visit.contact);
    const key = contact ? 'contact:' + contact : 'name:' + visit.client_name.trim().toLowerCase();
    if (!clients.has(key)) {
      const next = [visit.next_visit, upcoming.get(contact)].filter(day => day && day >= today).sort()[0];
      clients.set(key, {visit, next, due:visit.follow_up || addDays(visit.visit_date, 42), count:0});
    }
    clients.get(key).count++;
  }
  return [...clients.values()];
}

async function readAll(query) {
  const results = [];
  for (let offset = 0; ; offset += 500) {
    const {data,error} = await query().range(offset, offset + 499);
    if (error) throw error;
    results.push(...data);
    if (data.length < 500) return results;
  }
}

export function setupBusiness(db) {
  const form = $('earnings-form');
  const status = $('earnings-status');
  const save = $('save-earnings');
  let visits = [];
  let bookings = [];
  let editing;
  let revision = 0;
  let requestId;
  let bookingError = false;

  function edit(visit) {
    editing = visit.id;
    requestId = undefined;
    for (const name of ['visit_date','client_name','contact','next_visit','follow_up']) {
      form.elements[name].value = visit[name] ?? '';
    }
    form.elements.sales.value = (visit.service_cents / 100).toFixed(2);
    form.elements.hair.value = (visit.hair_cents / 100).toFixed(2);
    form.elements.tips.value = (visit.tip_cents / 100).toFixed(2);
    save.textContent = 'Update visit';
    $('earnings-editor').open = true;
    form.elements.visit_date.focus();
  }

  function resetEditor() {
    editing = undefined;
    requestId = undefined;
    save.textContent = 'Save visit';
    form.elements.visit_date.defaultValue = localDay();
    form.reset();
  }

  function render() {
    const today = localDay();
    const period = $('earnings-period').value;
    const [previous, start] = periods(today, period);
    const current = visits.filter(visit => visit.visit_date >= start && visit.visit_date <= today);
    const prior = summarize(visits.filter(visit => visit.visit_date >= previous && visit.visit_date < start));
    const totals = summarize(current);
    const delta = totals.commission + totals.tips - prior.commission - prior.tips;
    $('earnings-totals').replaceChildren(...[
      ['Commission', dollars(totals.commission)],
      ['Tips', dollars(totals.tips)],
      ['Total earned', dollars(totals.commission + totals.tips)]
    ].map(([label,value]) => {
      const card = node('article','');
      card.append(node('span',label), node('strong',value));
      if (label === 'Total earned') {
        const movement = delta === 0 ? 'Same as' : dollars(Math.abs(delta)) + (delta > 0 ? ' more than' : ' less than');
        card.append(node('p',movement + ' last full ' + period));
      }
      return card;
    }));
    $('earnings-history').replaceChildren(...current.map(visit => {
      const card = node('article','');
      const button = node('button','Edit visit');
      button.onclick = () => edit(visit);
      card.append(node('h3',visit.client_name), node('p',visit.visit_date + ' · ' +
        dollars(commission(visit)) + ' commission · ' + dollars(visit.tip_cents) + ' tips'), button);
      return card;
    }));
    if (!current.length) $('earnings-history').append(node('p','No visits logged in this period.'));

    const clients = retention(visits.filter(visit => visit.visit_date <= today), bookings, today);
    const booked = clients.filter(client => client.next).length;
    const returning = clients.filter(client => client.count > 1).length;
    $('retention-summary').textContent = clients.length
      ? booked + ' of ' + clients.length + ' clients have a next visit · ' + returning + ' have returned (' +
        Math.round(returning / clients.length * 100) + '% of logged clients)'
      : 'Log a completed visit to start tracking rebooking.';
    if (bookingError) $('retention-summary').textContent += ' Studio booking matches are temporarily unavailable.';
    const filter = $('retention-filter').value;
    const visible = clients.filter(client => ({
      due: !client.next && client.due <= today, open: !client.next, booked: Boolean(client.next), all: true
    })[filter]).sort((a,b) => a.due.localeCompare(b.due));
    $('retention-list').replaceChildren(...visible.map(({visit,next,due,count}) => {
      const card = node('article','');
      const button = node('button', 'Update next visit or follow-up');
      button.onclick = () => edit(visit);
      const state = next ? 'Booked for ' + next : 'Follow-up due ' + due;
      card.append(node('h3',visit.client_name),node('p',state + ' · ' + count +
        (count === 1 ? ' completed visit' : ' completed visits')),button);
      if (visit.contact) card.append(node('p',visit.contact));
      return card;
    }));
    if (!visible.length) $('retention-list').append(node('p','No clients in this view.'));
  }

  async function refresh() {
    const current = ++revision;
    const results = await Promise.allSettled([
      readAll(() => db.from('studio_earnings')
        .select('id,visit_date,client_name,contact,service_cents,hair_cents,tip_cents,next_visit,follow_up')
        .order('visit_date',{ascending:false}).order('created_at',{ascending:false}).order('id')),
      readAll(() => db.from('lola_requests').select('contact,email,starts_at')
        .eq('status','approved').gte('ends_at',new Date().toISOString()).order('starts_at').order('id'))
    ]);
    if (current !== revision) return false;
    if (results[0].status === 'rejected') {
      status.textContent = 'Could not load earnings. Use Refresh in appointment requests to try again.';
      return false;
    }
    visits = results[0].value;
    bookingError = results[1].status === 'rejected';
    bookings = bookingError ? [] : results[1].value;
    status.textContent = '';
    render();
    return true;
  }

  form.addEventListener('reset', () => {
    editing = undefined;
    requestId = undefined;
    save.textContent = 'Save visit';
  });
  form.addEventListener('input', () => { requestId = undefined; });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (save.disabled) return;
    const fields = new FormData(form);
    const visit = {
      visit_date:fields.get('visit_date'), client_name:fields.get('client_name').trim(),
      contact:fields.get('contact').trim(), service_cents:Math.round(Number(fields.get('sales')) * 100),
      hair_cents:Math.round(Number(fields.get('hair')) * 100),
      tip_cents:Math.round(Number(fields.get('tips')) * 100), next_visit:fields.get('next_visit') || null,
      follow_up:fields.get('follow_up') || null
    };
    if (!visit.client_name || visit.visit_date > localDay() ||
        (visit.next_visit && visit.next_visit <= visit.visit_date) ||
        (visit.follow_up && visit.follow_up < visit.visit_date)) {
      status.textContent = 'Enter a client and completed visit date. Next visits must be later and follow-ups cannot be earlier.';
      return;
    }
    save.disabled = true;
    form.inert = true;
    const current = revision;
    try {
      const query = db.from('studio_earnings');
      const operation = editing ? query.update(visit).eq('id',editing)
        : query.upsert({...visit,id:requestId ||= crypto.randomUUID()},{onConflict:'id'});
      const {error} = await operation.select('id').single();
      if ($('dash').hidden) return;
      if (error) throw error;
      resetEditor();
      $('earnings-editor').open = false;
      if (await refresh()) status.textContent = 'Visit saved.';
    } catch {
      if (current === revision && !$('dash').hidden) status.textContent = 'Could not save this visit. Try again.';
    } finally {
      save.disabled = false;
      form.inert = false;
    }
  });
  for (const id of ['earnings-period','retention-filter']) $(id).onchange = render;
  resetEditor();
  return {
    refresh,
    clear() {
      ++revision;
      visits = [];
      bookings = [];
      bookingError = false;
      resetEditor();
      $('earnings-editor').open = false;
      for (const id of ['earnings-totals','earnings-history','retention-list','retention-summary','earnings-status']) {
        $(id).replaceChildren();
      }
    }
  };
}
