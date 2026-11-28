import {appointmentControls, localDay, publicData} from './client.js';

const chat = document.getElementById('hairchat');
const quick = chat.querySelector('.chatquick');
const trigger = document.createElement('button');
trigger.type = 'button';
trigger.textContent = 'Book with Lola';
quick.append(trigger);
const panel = document.createElement('div');
panel.className = 'bubble';
panel.hidden = true;
panel.style.cssText = 'max-width:100%;width:100%';
panel.innerHTML = `
  <strong>Request an appointment with Marisa at Hottie Hair</strong>
  <p>West Charleston · 7871 W. Charleston Blvd, Suite 160, Las Vegas, NV 89117. Prices are estimates and may go up or down after consultation. Marisa will review your final quote before service begins.</p>
  <label>Service <select id="lola-service" required><option value="">Loading services…</option></select></label>
  <label>Date <input id="lola-date" type="date" required></label>
  <label>Start time, Pacific <select id="lola-time" disabled><option value="">Choose a service and date</option></select></label>
  <p id="lola-availability" role="status"></p>
  <form id="lola-appointment">
    <label>Full name <input name="fullName" autocomplete="name" required minlength="2" maxlength="100"></label>
    <label>Mobile number <input name="phone" type="tel" autocomplete="tel" required maxlength="24"></label>
    <label>Email <input name="email" type="email" autocomplete="email" required maxlength="254"></label>
    <label>Hair goals <textarea name="goals" rows="2" maxlength="1000"></textarea></label>
    <label><input name="consent" type="checkbox" required> I agree to receive appointment texts.</label>
    <button id="lola-reserve" disabled>Send appointment request</button>
  </form>
  <p id="lola-status" role="status"></p>`;
const area = document.getElementById('chatmessages');
const greeting = area.querySelector('.bubble');
if (greeting) greeting.textContent = 'Hi gorgeous! I’m Lola, Marisa’s personal AI assistant. Marisa is a hairstylist at Hottie Hair Salon · West Charleston (West Summerlin) · 7871 W. Charleston Blvd, Suite 160, Las Vegas, NV 89117. I can help with services, price estimates, and appointment requests. What can I help you with?';
area.append(panel);
const field = id => panel.querySelector('#lola-' + id);
const service = field('service');
const date = field('date');
const availability = field('availability');
date.min = localDay();
const upper = new Date(date.min + 'T12:00:00Z');
upper.setUTCDate(upper.getUTCDate() + 90);
date.max = upper.toISOString().slice(0,10);
const refresh = appointmentControls({
  date: () => date.value,
  time: field('time'),
  form: field('appointment'),
  submit: field('reserve'),
  status: field('status'),
  availability,
  selection: () => service.value ? {[service.value]:1} : {},
  onSuccess: text => {
    panel.hidden = true;
    addHairBubble(text,false);
    trigger.focus();
  }
});
service.onchange = date.onchange = refresh;
let catalog;
async function open() {
  area.append(panel);
  panel.hidden = false;
  area.scrollTop = area.scrollHeight;
  service.focus();
  if (catalog) return;
  try {
    catalog = await publicData('lola_services?select=name,category,pricing_unit&active=eq.true&order=category,name');
    service.replaceChildren(new Option('Choose a service',''));
    const groups = new Map();
    for (const item of catalog) {
      if (item.category.startsWith('Hair only') || item.category === 'Color Add-Ons' ||
          item.pricing_unit?.startsWith('Hair from ')) continue;
      if (!groups.has(item.category)) {
        const group = document.createElement('optgroup');
        group.label = item.category;
        groups.set(item.category,group);
        service.append(group);
      }
      groups.get(item.category).append(new Option(item.name + ' · ' + item.pricing_unit,item.name));
    }
    availability.textContent = '';
  } catch (error) {
    availability.textContent = error.message;
  }
}
trigger.onclick = open;
document.addEventListener('studio:lola-booking',open);
