import {createClient} from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/+esm';
import {database, publishableKey, localDay, localTime, displayTime} from './client.js';

const linkError = new URLSearchParams(location.hash.slice(1)).get('error_code');
const db = createClient(database, publishableKey);
const $ = id => document.getElementById(id);
const message = value => { $('message').textContent = value; };
const month = new Date(localDay().slice(0,7) + '-01T12:00:00Z');
const columns = 'id,client_name,contact,email,service,preferred_time,notes,status,starts_at,ends_at';
let selected = '';
let loadVersion = 0;
let rows = [];
const node = (tag, value) => Object.assign(document.createElement(tag), {textContent:value});
const control = (label, type, value, options = {}) => {
  const field = node('label', label + ' ');
  const input = Object.assign(document.createElement('input'), {type,value,required:true,...options});
  field.append(input);
  return [field,input];
};
async function manage(args, button) {
  button.disabled = true;
  message('');
  try {
    const {error} = await db.rpc('studio_manage', args);
    if (error) throw error;
    await load();
    message({block:'Time blocked.',cancel:'Calendar updated.',approve:'Appointment approved.',reschedule:'Appointment rescheduled.'}[args.action]);
  } catch (error) {
    message(error.message || 'The calendar could not be updated.');
  } finally {
    button.disabled = false;
  }
}
function render() {
  $('month').textContent = month.toLocaleDateString('en-US',{month:'long',year:'numeric',timeZone:'UTC'});
  const cal = $('calendar');
  cal.replaceChildren(...['S','M','T','W','T','F','S'].map(d => node('span',d)));
  for (let i = 0; i < month.getUTCDay(); i++) cal.append(document.createElement('span'));
  const day = new Date(month);
  while (day.getUTCMonth() === month.getUTCMonth()) {
    const key = day.toISOString().slice(0,10);
    const button = node('button',day.getUTCDate());
    const count = rows.filter(row => row.starts_at && localDay(new Date(row.starts_at)) === key
      && ['pending','approved','blocked'].includes(row.status)).length;
    if (count) button.append(node('small',count));
    button.setAttribute('aria-pressed',String(key === selected));
    button.setAttribute('aria-label',key + ', ' + count + ' active calendar entries');
    button.onclick = () => { selected = key; $('block').elements.day.value = key; render(); };
    cal.append(button);
    day.setUTCDate(day.getUTCDate()+1);
  }
  $('list-title').textContent = selected ? 'Calendar for ' + selected : 'Appointment requests and blocks';
  const list = $('requests');
  list.replaceChildren();
  for (const row of rows) {
    const date = row.starts_at && new Date(row.starts_at);
    if (selected && (!date || localDay(date) !== selected)) continue;
    const article = document.createElement('article');
    article.append(node('h3',row.client_name),node('p',row.status + ' · ' + row.service));
    const duration = date && Math.round((new Date(row.ends_at) - date) / 60000);
    article.append(node('p',date
      ? localDay(date) + ' at ' + displayTime(localTime(date)) + ' Pacific · ' + duration + ' min'
      : row.preferred_time || 'Time to be assigned'));
    for (const detail of [row.contact,row.email,row.notes]) if (detail) article.append(node('p',detail));
    function action(label, action, confirmation) {
      const button = node('button',label);
      button.onclick = () => {
        if (!confirmation || confirm(confirmation)) manage({action,appointment_id:row.id},button);
      };
      article.append(button);
    }
    if (row.status === 'pending' && date > new Date()) action('Approve','approve');
    if (['pending','approved','blocked','contacted'].includes(row.status)) {
      const block = row.status === 'blocked';
      action(block ? 'Remove block' : 'Cancel appointment','cancel',
        block ? 'Remove this availability block?' : 'Cancel this appointment and reopen the time?');
      if (!block) {
        const editor = document.createElement('details');
        editor.append(node('summary','Reschedule or change duration'));
        const form = document.createElement('form');
        const [dayField,newDay] = control('Date','date',date ? localDay(date) : localDay());
        const [timeField,newTime] = control('Start, Pacific','time',date ? localTime(date) : '10:00',{step:900});
        const [durationField,newDuration] = control('Minutes','number',duration || 60,{min:15,max:480});
        const save = node('button','Save time');
        form.append(dayField,timeField,durationField,save);
        form.onsubmit = event => {
          event.preventDefault();
          manage({action:'reschedule',appointment_id:row.id,day:newDay.value,
            start_time:newTime.value,duration:Number(newDuration.value)},save);
        };
        editor.append(form);
        article.append(editor);
      }
    }
    list.append(article);
  }
  if (!list.childElementCount) list.append(node('p','No calendar entries.'));
}
async function load() {
  const version = ++loadVersion;
  const start = new Date(month);
  start.setUTCDate(0);
  const end = new Date(month);
  end.setUTCMonth(end.getUTCMonth()+1);
  end.setUTCDate(2);
  const {data,error} = await db.from('lola_requests').select(columns)
    .or('starts_at.is.null,and(starts_at.gte.' + start.toISOString() + ',starts_at.lt.' + end.toISOString() + ')')
    .order('starts_at',{ascending:true});
  if (version !== loadVersion) return;
  if (error) { message(error.message); return; }
  const prefix = month.toISOString().slice(0,7);
  rows = data.filter(row => !row.starts_at || localDay(new Date(row.starts_at)).startsWith(prefix));
  render();
}
async function show(user) {
  const {data,error} = user ? await db.rpc('studio_is_admin') : {data:false};
  $('login').hidden = data === true;
  $('dash').hidden = data !== true;
  if (data) await load();
  else {
    ++loadVersion;
    rows = [];
    clearPrivateTools();
    $('requests').replaceChildren();
    $('calendar').replaceChildren();
    if (user) message(error ? 'Could not verify admin access.' : 'This account does not have admin access.');
  }
  return data === true;
}
$('form').onsubmit = async event => {
  event.preventDefault();
  const {data,error} = await db.auth.signInWithPassword({email:$('email').value,password:$('password').value});
  $('password').value = '';
  if (error) message(error.message);
  else { message(''); await show(data.user); }
};
$('magic').onclick = async () => {
  if (!$('email').reportValidity() || !$('email').value) return message('Enter your email address.');
  const {error} = await db.auth.signInWithOtp({email:$('email').value,
    options:{shouldCreateUser:false,emailRedirectTo:location.origin + '/admin.html'}});
  message(error?.message || 'Check your email for a sign-in link.');
};
const recovery = node('button', 'Set or reset password');
recovery.type = 'button';
$('magic').after(recovery);
recovery.onclick = async () => {
  if (!$('email').reportValidity()) return;
  recovery.disabled = true;
  try {
    const {error} = await db.auth.resetPasswordForEmail($('email').value, {
      redirectTo: location.origin + '/admin.html'
    });
    message(error?.message || 'Check your email for a password reset link.');
  } catch {
    message('Could not send the email. Try again.');
  } finally {
    recovery.disabled = false;
  }
};

const passwordSettings = document.createElement('details');
passwordSettings.append(node('summary', 'Set or change password'));
const passwordForm = document.createElement('form');
const [newLabel, newPassword] = control('New password', 'password', '', {
  autoComplete: 'new-password', minLength: 12
});
const [confirmLabel, confirmPassword] = control('Confirm new password', 'password', '', {
  autoComplete: 'new-password', minLength: 12
});
const savePassword = node('button', 'Save password');
const passwordMessage = node('p', 'Use at least 12 characters.');
passwordMessage.setAttribute('role', 'status');
passwordForm.append(newLabel, confirmLabel, savePassword, passwordMessage);
passwordSettings.append(passwordForm);
$('logout').after(passwordSettings);
passwordSettings.addEventListener('toggle', () => {
  if (!passwordSettings.open) passwordForm.reset();
});
passwordForm.onsubmit = async event => {
  event.preventDefault();
  if (newPassword.value !== confirmPassword.value) {
    passwordMessage.textContent = 'The passwords don’t match.';
    return;
  }
  savePassword.disabled = true;
  try {
    const {data: isAdmin, error: checkError} = await db.rpc('studio_is_admin');
    if (checkError || !isAdmin) {
      passwordMessage.textContent = 'Sign in as the studio admin to set your password.';
      return;
    }
    const {error} = await db.auth.updateUser({password:newPassword.value});
    if (error) {
      passwordMessage.textContent = error.message;
      return;
    }
    passwordForm.reset();
    passwordSettings.open = false;
    message('Password saved. You can use it the next time you sign in.');
  } catch {
    passwordMessage.textContent = 'Could not save your password. Try again.';
  } finally {
    savePassword.disabled = false;
  }
};
if (linkError) message('This email link is invalid or expired. Request a fresh link.');

$('logout').onclick = async () => {
  const {error} = await db.auth.signOut();
  message(error?.message || 'Signed out.');
  if (!error) {
    passwordForm.reset();
    passwordSettings.open = false;
    await show(null);
  }
};
$('refresh').onclick = load;
$('back').onclick = () => { month.setUTCMonth(month.getUTCMonth()-1); selected=''; load(); };
$('forward').onclick = () => { month.setUTCMonth(month.getUTCMonth()+1); selected=''; load(); };
$('all-days').onclick = () => { selected=''; render(); };
$('block').elements.day.value = localDay();
$('block').onsubmit = event => {
  event.preventDefault();
  const fields = new FormData(event.currentTarget);
  manage({action:'block',day:fields.get('day'),start_time:fields.get('time'),duration:Number(fields.get('duration'))},event.submitter);
};
db.auth.onAuthStateChange((event,session) => {
  if (event === 'PASSWORD_RECOVERY') {
    setTimeout(async () => {
      if (await show(session?.user)) {
        passwordSettings.open = true;
        newPassword.focus();
        message('Choose your new admin password below.');
      }
    }, 0);
  }
  if (event === 'INITIAL_SESSION' || event === 'SIGNED_OUT' || event === 'SIGNED_IN') {
    setTimeout(() => show(session?.user),0);
  }
});

let directory = [];
let directoryVersion = 0;
function renderClients() {
  const query = $('client-search').value.trim().toLowerCase();
  const digits = query.replace(/\D/g, '');
  const matches = directory.filter(client =>
    [client.client_name,client.email,client.contact].some(value => value?.toLowerCase().includes(query)) ||
    (digits.length >= 3 && client.contact?.includes(digits)));
  $('client-list').replaceChildren(...matches.slice(0, 50).map(client => {
    const card = document.createElement('article');
    card.append(node('h3',client.client_name));
    for (const detail of [client.contact,client.email,client.service]) {
      if (detail) card.append(node('p',detail));
    }
    return card;
  }));
  $('client-status').textContent = matches.length > 50
    ? 'Showing the first 50 clients. Search to narrow the list.'
    : matches.length ? matches.length + (matches.length === 1 ? ' client' : ' clients') : 'No clients found.';
}
$('client-search').oninput = renderClients;
$('client-directory').ontoggle = async () => {
  if (!$('client-directory').open || $('dash').hidden) return;
  const version = ++directoryVersion;
  $('client-status').textContent = 'Loading clients…';
  const clients = new Map();
  const size = 500;
  for (let offset = 0; ; offset += size) {
    const {data,error} = await db.from('lola_requests')
      .select('client_name,contact,email,service')
      .neq('service','Unavailable')
      .order('created_at',{ascending:false}).order('id')
      .range(offset,offset + size - 1);
    if (version !== directoryVersion || $('dash').hidden) return;
    if (error) {
      $('client-status').textContent = 'Could not load clients.';
      return;
    }
    for (const client of data) {
      const key = client.email?.toLowerCase() || client.contact;
      if (key && !clients.has(key)) clients.set(key,client);
    }
    if (data.length < size) break;
  }
  directory = [...clients.values()];
  renderClients();
};

let lolaMessages = [];
let lolaRevision = 0;
$('admin-lola').onsubmit = async event => {
  event.preventDefault();
  const input = event.currentTarget.elements.question;
  const question = input.value.trim();
  if (!question) return;
  const version = ++lolaRevision;
  const button = event.submitter;
  const log = $('admin-lola-log');
  button.disabled = true;
  input.value = '';
  log.append(node('p', 'You: ' + question));
  try {
    const messages = [...lolaMessages, {role:'user',content:question}].slice(-19);
    const response = await fetch('/api/lola', {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({messages}),
      signal:AbortSignal.timeout(25000)
    });
    if (!response.ok) throw new Error('Lola unavailable');
    const {reply} = await response.json();
    if (version !== lolaRevision || $('dash').hidden) return;
    lolaMessages = [...messages, {role:'assistant',content:reply}];
    log.append(node('p','Lola: ' + reply));
  } catch {
    if (version === lolaRevision) log.append(node('p','Lola is temporarily unavailable.'));
  } finally {
    button.disabled = false;
  }
};
function clearPrivateTools() {
  ++directoryVersion;
  ++lolaRevision;
  directory = [];
  lolaMessages = [];
  $('client-directory').open = false;
  $('client-search').value = '';
  $('client-list').replaceChildren();
  $('client-status').textContent = '';
  $('admin-lola').reset();
  $('admin-lola-log').replaceChildren();
}
