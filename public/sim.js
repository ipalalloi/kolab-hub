const $ = (s) => document.querySelector(s);
const toast = (m) => { const t = $('#toast'); t.textContent = m; t.hidden = false; setTimeout(() => { t.hidden = true; }, 3000); };
const post = async (path, body) => {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-kolab-csrf': '1' }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || r.status);
  return d;
};

for (const p of ['#tugasku', '#DIS-0001 mulai', '#DIS-0001 50% sudah survei', '#DIS-0001 selesai', '#DIS-0001 tahan menunggu izin', '#baru DIS Usulan baru', '#bantuan']) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'btn small'; b.textContent = p;
  b.onclick = () => { $('#text').value = p; };
  $('#presets').append(b);
}

async function loadOutbox() {
  const r = await fetch('/api/sim/outbox');
  const rows = await r.json();
  const ul = $('#outbox');
  ul.replaceChildren();
  for (const m of rows) {
    const li = document.createElement('li');
    const head = document.createElement('div');
    head.className = 'row';
    const meta = document.createElement('span');
    meta.className = 'muted grow';
    meta.textContent = `→ ${m.to || '[dihapus]'} · ${m.kind} · ${m.status} · ${new Date(m.created_at).toLocaleTimeString('id-ID')}`;
    const btn = document.createElement('button');
    btn.className = 'btn small'; btn.textContent = 'balas';
    btn.onclick = () => { $('#ctx').value = m.provider_id || ''; if (m.to) $('#phone').value = m.to; $('#text').focus(); };
    head.append(meta, btn);
    const body = document.createElement('pre');
    body.style.whiteSpace = 'pre-wrap'; body.style.margin = '6px 0 0';
    body.textContent = m.text;
    li.append(head, body);
    ul.append(li);
  }
}

$('#send').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await post('/api/sim/inbound', { phone: $('#phone').value, text: $('#text').value, context_id: $('#ctx').value || undefined, media_type: $('#media').value || undefined });
    $('#ctx').value = '';
    setTimeout(loadOutbox, 300);
  } catch (err) { toast(err.message); }
});
$('#refresh').onclick = loadOutbox;
loadOutbox();
setInterval(loadOutbox, 4000);
