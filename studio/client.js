export const database = 'https://lfnthpzffdfnhysqtitb.supabase.co';
export const publishableKey = 'sb_publishable_XT9dhSJTw7Jlh-yZxFBjTA_Yijruhz3';
export const zone = 'America/Los_Angeles';
const dateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit'
});
const timeFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});

export const localDay = (date = new Date()) => dateFormat.format(date);
export const localTime = date => timeFormat.format(date);
export const displayTime = time => new Date('2000-01-01T' + time).toLocaleTimeString(
  'en-US', {hour:'numeric', minute:'2-digit'}
);

export async function publicData(path, args) {
  const headers = {apikey: publishableKey};
  if (args) headers['Content-Type'] = 'application/json';
  const response = await fetch(database + '/rest/v1/' + path, {
    headers, method: args ? 'POST' : 'GET', body: args ? JSON.stringify(args) : undefined,
    signal: AbortSignal.timeout(12000)
  });
  const result = await response.json();
  if (!response.ok) {
    const permitted = ['22023', '23P01'];
    throw new Error(permitted.includes(result.code) ? result.message : 'Booking is temporarily unavailable. Please try again.');
  }
  return result;
}

export function appointmentControls({date, time, form, submit, status, availability, selection, onSuccess}) {
  let revision = 0;
  let sending = false;
  let requestKey;
  const options = (label, slots = []) => {
    time.replaceChildren(new Option(label, ''), ...slots.map(slot =>
      new Option(displayTime(slot.start_time), slot.start_time)));
    time.disabled = !slots.length || sending;
    submit.disabled = !time.value || sending;
  };
  async function refresh() {
    const id = ++revision;
    const items = selection();
    requestKey = undefined;
    status.textContent = '';
    availability.textContent = '';
    if (!date() || !Object.keys(items).length) {
      options('Choose services and a date');
      return;
    }
    options('Checking availability…');
    try {
      const slots = await publicData('rpc/studio_slots', {day: date(), items});
      if (id !== revision) return;
      options(slots.length ? 'Choose a time' : 'No times available', slots);
      if (!slots.length) availability.textContent = 'Try another date or service selection.';
    } catch (error) {
      if (id !== revision) return;
      options('Unavailable');
      availability.textContent = error.message;
    }
  }
  time.addEventListener('change', () => {
    requestKey = undefined;
    submit.disabled = !time.value || sending;
  });
  form.addEventListener('input', () => { if (!sending) requestKey = undefined; });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!time.value || sending) return;
    sending = true;
    submit.disabled = true;
    const fields = new FormData(form);
    const args = {
      request_key: requestKey ||= crypto.randomUUID(),
      day: date(), start_time: time.value, items: selection(),
      full_name: fields.get('fullName'), phone: fields.get('phone'), customer_email: fields.get('email'),
      goals: fields.get('goals'), agreed: fields.has('consent')
    };
    form.inert = true;
    time.disabled = true;
    status.textContent = 'Sending your request…';
    try {
      const id = await publicData('rpc/studio_request', args);
      form.reset();
      await refresh();
      status.textContent = 'Request received for ' + args.day + ' at ' + displayTime(args.start_time) +
        ' Pacific with Marisa at Hottie Hair, West Charleston. Marisa will review it before your appointment is confirmed.';
      onSuccess?.(status.textContent, id);
    } catch (error) {
      if (error.message.includes('just taken')) await refresh();
      status.textContent = error.message;
    } finally {
      sending = false;
      form.inert = false;
      time.disabled = time.options.length < 2;
      submit.disabled = !time.value;
      if (status.isConnected && status.tabIndex === -1) status.focus();
    }
  });
  return refresh;
}
