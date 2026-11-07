// Tata bahasa perintah WA yang sengaja kecil (bot sempit sesuai kebijakan WhatsApp Business 2026).
//   #DIS-0142 mulai | #DIS-0142 50% catatan | #DIS-0142 progres 50 catatan
//   #DIS-0142 selesai [catatan] | #DIS-0142 tahan <alasan> | #DIS-0142 bantuan [catatan]
//   #DIS-0142 <teks lain>  -> komentar
//   #tugasku | #bantuan | #baru [PREFIX] <judul>
// Tanpa kode (balasan/quote ke notifikasi kartu): "mulai", "selesai ...", "60% ...", "tahan ..."

const CODE_RE = /^#\s*([A-Za-z]{2,6})-?(\d{1,6})\b\s*([\s\S]*)$/;
const VERB = {
  mulai: 'mulai', start: 'mulai', kerjakan: 'mulai', lanjut: 'mulai',
  selesai: 'selesai', done: 'selesai', beres: 'selesai',
  tahan: 'tahan', hold: 'tahan', pending: 'tahan',
  progres: 'progres', progress: 'progres',
  bantuan: 'bantuan', tolong: 'bantuan',
};

export function formatCode(prefix, num) {
  return `${prefix.toUpperCase()}-${String(Number(num)).padStart(4, '0')}`;
}

/** Urai bagian setelah kode kartu (atau seluruh pesan bila konteks dari quote). */
export function parseAction(rest) {
  const text = String(rest || '').trim();
  if (!text) return null;
  const pct = text.match(/^(?:(?:progres|progress)\s+)?(\d{1,3})\s*%?\s*([\s\S]*)$/i);
  if (pct && (text.includes('%') || /^(progres|progress)\b/i.test(text))) {
    return { action: 'progres', args: { percent: Number(pct[1]), note: pct[2].trim() } };
  }
  const [first, ...more] = text.split(/\s+/);
  const verb = VERB[first.toLowerCase().replace(/[.!,:]$/, '')];
  const tail = text.slice(first.length).trim();
  if (!verb) return null;
  switch (verb) {
    case 'mulai': return { action: 'mulai', args: {} };
    case 'selesai': return { action: 'selesai', args: { note: tail } };
    case 'tahan': return { action: 'tahan', args: { reason: tail } };
    case 'bantuan': return { action: 'bantuan', args: { note: tail } };
    case 'progres': {
      const n = more[0] && more[0].match(/^(\d{1,3})%?$/);
      if (n) return { action: 'progres', args: { percent: Number(n[1]), note: more.slice(1).join(' ') } };
      return { action: 'progres', args: { percent: NaN, note: tail } };
    }
    default: return null;
  }
}

export function parseMessage(body) {
  const text = String(body || '').trim();
  if (!text) return { kind: 'empty' };
  const low = text.toLowerCase();
  if (/^#tugasku\b/.test(low) || /^#tugas\s*saya\b/.test(low)) return { kind: 'mytasks' };
  if (/^#(bantuan|help|panduan)\s*$/.test(low)) return { kind: 'help' };
  const baru = text.match(/^#baru\b\s*([\s\S]*)$/i);
  if (baru) {
    const rest = baru[1].trim();
    const m = rest.match(/^([A-Za-z]{2,6})\s+([\s\S]+)$/);
    return { kind: 'new', prefixCandidate: m ? m[1].toUpperCase() : null, titleIfPrefix: m ? m[2].trim() : null, title: rest };
  }
  const c = text.match(CODE_RE);
  if (c) {
    const code = formatCode(c[1], c[2]);
    const act = parseAction(c[3]);
    if (act) return { kind: 'card', code, ...act };
    if (c[3].trim()) return { kind: 'card', code, action: 'komentar', args: { text: c[3].trim() } };
    return { kind: 'card', code, action: null, args: {} };
  }
  const act = parseAction(text);
  if (act) return { kind: 'contextual', ...act };
  return { kind: 'unknown', text };
}

export const HELP_TEXT = [
  'Perintah Kolab-Hub:',
  '#KODE mulai — mulai kerjakan, mis. #DIS-0142 mulai',
  '#KODE 50% catatan — lapor progres',
  '#KODE selesai catatan — kirim untuk ditinjau (boleh lampirkan foto/dokumen)',
  '#KODE tahan alasan — tahan kartu',
  '#KODE bantuan catatan — minta bantuan koordinator',
  '#tugasku — daftar tugas Anda',
  'Balas (quote) notifikasi kartu cukup dengan "mulai", "selesai", atau "60%".',
].join('\n');
