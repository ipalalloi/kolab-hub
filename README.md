# Kolab-Hub

Sistem kolaborasi berbasis web, PWA, dan WhatsApp. Setiap instruksi kerja menjadi kartu kanban. Kolaborator dapat melapor langsung lewat WhatsApp, dan semua laporan terekap ke satu **event log append-only** yang bisa dikoreksi dari web.

Model kerjanya:

- **Web** adalah sumber kebenaran.
- **WhatsApp** adalah pintu masuk laporan.
- **PWA** adalah remote untuk menjalankan tugas dari ponsel.

Rancangan resmi (berstatus FINAL per 7 November 2026) ada di dokumen *Kajian & Rancangan Sistem Kolaborasi Web + PWA + WhatsApp* di Project "WA Colaborator".

## Status

| Fase | Isi | Status |
| --- | --- | --- |
| MVP | Workspace, anggota dan verifikasi nomor, kanban, kartu, event log, webhook WA (tanda tangan, antrean, idempoten), perintah `#kode mulai/progres/selesai/tahan`, `#tugasku`, PWA dasar, mode simulasi WA | di `main`, berjalan di VPS |
| Fase 2 | Web Push, mode luring dengan antrean sinkron, ringkasan harian, dasbor beban kerja, ekspor | cabang `feat/fase-2` |
| Fase 3 | Parsing bahasa alami terbatas, saran penugasan, integrasi kalender/Drive | belum |

## Arsitektur singkat

```
WhatsApp ──► BSP/Meta ──► POST /webhook/whatsapp ──► wa_messages (terenkripsi) ──► jobs ──► worker
                                   (verifikasi HMAC, balas 200)                                  │
Web/PWA ──► /api/* (sesi cookie, CSRF) ─────────────────────────────────────────────────────────┤
                                                                                                 ▼
                                             aturan transisi + hak akses (src/domain/actions.js)
                                                                                                 ▼
                                   events (append-only) ──► proyeksi cards ──► SSE /api/stream ──► papan real-time
```

- **Event log**: status kartu tidak pernah ditimpa. Status dihitung ulang dari urutan event (`src/domain/reducer.js`). Koreksi dibuat sebagai event `event.reverted` baru, sehingga riwayat asli tetap ada. Trigger basis data menolak `UPDATE` dan `DELETE` pada tabel `events` dan `audit_log`.
- **Idempoten**: id pesan Meta (`wamid…`) menjadi kunci utama `wa_messages`. Webhook yang dikirim ulang tidak diproses dua kali.
- **Antrean**: tabel `jobs`. Di PostgreSQL dipakai `FOR UPDATE SKIP LOCKED`. Pesan tidak hilang walau proses mati, karena tugas yang macet dikembalikan ke antrean.
- **Satu nomor WA untuk semua proyek**: kode kartu berawalan proyek (mis. `DIS-0142`) dan unik lintas workspace. `#tugasku` menampilkan tugas dari semua proyek.

## Perintah WhatsApp

| Pesan | Hasil |
| --- | --- |
| `#DIS-0142 mulai` | Kartu pindah ke **Dikerjakan** (dibatasi WIP per orang) |
| `#DIS-0142 50% sudah survei 3 lokasi` | Progres 50% + catatan |
| `#DIS-0142 selesai` + foto/dokumen | Kartu pindah ke **Ditinjau**, lampiran tercatat |
| `#DIS-0142 tahan menunggu izin` | Kartu pindah ke **Tertahan** (alasan wajib) |
| `#DIS-0142 bantuan …` | Meminta bantuan koordinator |
| `#DIS-0142 teks lain` | Komentar di kartu |
| `#tugasku` | Daftar tugas aktif dari semua proyek |
| `#baru DIS Judul` | Koordinator: kartu baru. Kolaborator: **usulan** yang menunggu persetujuan |
| `#bantuan` | Daftar perintah |
| Balas (quote) notifikasi kartu dengan `mulai`, `selesai`, atau `60%` | Tidak perlu menulis kode kartu |

Pesan yang tidak cocok pola tidak dibuang. Pesan itu disimpan sebagai komentar **perlu dicek** di kartu aktif terakhir pengirim, atau masuk ke halaman **Tinjauan**. Pesan dari nomor yang belum terverifikasi tidak diproses dan tidak dibalas.

## Coba di komputer sendiri (mode simulasi, tanpa akun BSP)

Prasyarat: Node.js 22.5 atau lebih baru. Tidak perlu `npm install`, karena mode ini memakai SQLite bawaan Node.

```bash
npm run seed      # data contoh: 1 workspace, 2 proyek, 5 kartu, 5 orang fiktif
npm start         # http://localhost:3000
```

- Masuk di `http://localhost:3000/#/masuk` dengan nomor contoh, mis. `6281200000002` (koordinator) atau `6281200000003` (kolaborator). Kode OTP tampil di **`/sim`**.
- Halaman **`/sim`** mengirim pesan WA tiruan ke webhook yang sama dengan Meta, lengkap dengan tanda tangan HMAC. Pesan keluar (balasan, OTP, notifikasi tugas) juga tampil di sana.
- Jalankan uji: `npm test`.

> Mode simulasi menampilkan semua OTP di `/sim`. Jangan membukanya ke internet. Di produksi, aplikasi menolak berjalan dengan `WA_MODE=simulate`.

## Pasang di VPS (Singapura atau wilayah terdekat)

Contoh di bawah untuk Ubuntu 24.04 dengan Docker.

1. **Siapkan server.** Pasang Docker dan plugin compose. Arahkan DNS `A` domain Anda (mis. `kolab.contoh.id`) ke IP VPS. Buka hanya port 22, 80, dan 443.
2. **Ambil kode.**
   ```bash
   sudo mkdir -p /opt/kolab-hub && sudo chown $USER /opt/kolab-hub
   git clone https://github.com/ipalalloi/kolab-hub /opt/kolab-hub && cd /opt/kolab-hub
   ```
3. **Isi `.env` di VPS** (bukan di repo atau chat):
   ```bash
   cp .env.example .env && chmod 600 .env
   node scripts/gen-keys.js     # atau: docker run --rm -v $PWD:/a -w /a node:22-alpine node scripts/gen-keys.js
   nano .env                    # tempel kunci, isi DOMAIN, BASE_URL, BACKUP_PASSPHRASE
   ```
   Untuk uji coba awal di VPS sebelum akun BSP siap, `WA_MODE=simulate` boleh dipakai sementara dengan `ALLOW_SIMULATE_IN_PRODUCTION=true`. Matikan lagi setelah selesai.
4. **Jalankan.**
   ```bash
   docker compose up -d --build
   docker compose logs -f app      # migrasi berjalan otomatis saat start
   ```
5. **Buat pemilik pertama.**
   ```bash
   docker compose exec app node --no-warnings=ExperimentalWarning scripts/create-owner.js \
     --name "Nama Anda" --phone 0812xxxxxxx --workspace "Nama Tim"
   ```
   Setelah itu masuk di `https://DOMAIN/#/masuk`.
6. **Cadangan harian terenkripsi** (disimpan 30 hari):
   ```bash
   chmod +x deploy/backup.sh
   (crontab -l; echo "15 2 * * * /opt/kolab-hub/deploy/backup.sh >> /var/log/kolab-backup.log 2>&1") | crontab -
   ```
   Lakukan uji pemulihan bulanan dengan perintah yang ada di akhir `deploy/backup.sh`.
7. **Perbarui versi**: `git pull && docker compose up -d --build`.

### Menghubungkan WhatsApp (BSP lokal + Cloud API resmi)

1. Selesaikan onboarding dan verifikasi bisnis di BSP. Pastikan BSP memakai **WhatsApp Cloud API resmi** dan bisa meneruskan webhook ke server sendiri.
2. Isi `.env`:
   - `WA_MODE=cloud`
   - `WA_APP_SECRET`: App Secret Meta, atau rahasia penandatanganan webhook dari BSP
   - `WA_VERIFY_TOKEN`
   - `WA_PHONE_NUMBER_ID`
   - `WA_ACCESS_TOKEN`
   - `WA_API_BASE`: Graph API Meta, atau endpoint Cloud API milik BSP
3. Daftarkan webhook dengan URL `https://DOMAIN/webhook/whatsapp`, token verifikasi sama dengan `WA_VERIFY_TOKEN`, dan langganan field `messages`.
4. Ajukan template berbahasa Indonesia ke Meta:
   - `kolab_otp` (kategori **authentication**): kode OTP dengan tombol salin kode.
   - `kolab_tugas_baru` (kategori **utility**): `Tugas baru {{1}}: {{2}}. Balas pesan ini dengan "mulai" untuk mulai mengerjakan. {{3}}`
5. Restart: `docker compose up -d`. Lalu cek `https://DOMAIN/healthz`, yang harus menampilkan `"wa_mode":"cloud"`.

Bila BSP menandatangani webhook dengan skema yang berbeda dari `X-Hub-Signature-256`, sesuaikan `src/wa/webhook.js` sebelum produksi. Sistem menolak setiap request yang tanda tangannya tidak cocok.

## Fase 2: push, luring, ringkasan, beban kerja, ekspor

### Web Push (push-first)

Notifikasi dikirim lewat Web Push PWA (gratis) bila penerima sudah mengaktifkannya; WhatsApp hanya cadangan.

| Kejadian | Penerima | Kanal |
| --- | --- | --- |
| Kartu ditugaskan | penanggung jawab | push; bila belum berlangganan → template WA `kolab_tugas_baru` (seperti MVP) |
| Kartu ditandai selesai (menunggu tinjauan) | pemilik dan koordinator | hanya push |
| Revisi diminta | penanggung jawab | hanya push |
| Minta bantuan | pemilik dan koordinator | hanya push |

Pelaku tidak diberi tahu tentang tindakannya sendiri. Notifikasi selain penugasan dibaca dari event log, jadi berlaku sama untuk laporan dari web, PWA, maupun WA.

Pengaktifan di VPS:

1. `npm run gen-keys` lalu salin `VAPID_PUBLIC_KEY` dan `VAPID_PRIVATE_KEY` ke `.env` (jangan ke chat atau repo). Isi juga `VAPID_SUBJECT=mailto:admin@domain-anda`.
2. Restart. Server menolak start bila kunci tidak berpasangan atau subjek kosong.
3. Anggota membuka **Akun → Aktifkan notifikasi** lalu **Kirim uji**.

Catatan perangkat: di iPhone/iPad (iOS 16.4+) push hanya tersedia setelah Kolab-Hub dipasang ke Layar Utama dan dibuka dari ikonnya. Mode penyamaran tidak mendukung push. Mengganti kunci VAPID membatalkan semua langganan; anggota perlu mengaktifkan ulang.

Enkripsi isi notifikasi (RFC 8291) dan VAPID (RFC 8292) ditulis dengan `node:crypto` tanpa paket tambahan dan diuji byte demi byte terhadap vektor uji RFC 8291. Endpoint dan kunci langganan disimpan terenkripsi. Langganan yang dicabut atau kedaluwarsa (HTTP 404/410) dihapus otomatis.

### Mode luring

Di PWA, tindakan kartu (mulai, lapor progres, selesai, tahan, bantuan, komentar, dan tombol koordinator) tetap bisa dilakukan tanpa sinyal. Tindakan disimpan di perangkat (IndexedDB) dan dikirim berurutan saat tersambung lagi, saat aplikasi dibuka, atau tiap 30 detik.

- Setiap tindakan membawa `x-kolab-op-id` unik. Server mencatatnya di `client_ops`, jadi kiriman ulang tidak pernah tercatat dua kali.
- Waktu tindakan dilakukan dicatat di event sebagai `offline_at` (diterima bila ≤ 7 hari lalu dan tidak di masa depan). Urutan di log tetap urutan diterima server.
- Tindakan divalidasi terhadap keadaan kartu terbaru. Bila ditolak (misalnya kartu sudah disetujui orang lain), tindakan muncul di **Tugas saya → Ditolak server** beserta alasannya.
- Tugas saya, akun, detail kartu, dan papan yang pernah dibuka dapat dibaca saat luring. Salinan ini dan antrean dihapus saat keluar akun.

### Ringkasan harian

Satu pesan per orang per hari pada `DIGEST_TIME` (bawaan 07:00) di zona `DIGEST_TZ` (bawaan `Asia/Makassar`). Isinya tugas aktif, terlambat, tenggat hari ini, tertahan, dan untuk koordinator jumlah kartu menunggu tinjauan, perlu dicek, serta usulan baru. Orang tanpa apa pun untuk dilaporkan tidak dikirimi.

- Kanal per orang di **Akun**: otomatis (push bila ada, selain itu WA), hanya push, hanya WA, atau tidak dikirim.
- Ringkasan lewat WA berada di luar jendela 24 jam, jadi wajib template. Ajukan template **utility** `kolab_ringkasan_harian`: `Ringkasan {{1}}: {{2}}. Lihat tugas Anda: {{3}}`.
- Pemasangan pertama hanya menandai hari itu; ringkasan pertama keluar keesokan harinya, bukan saat server diperbarui.

### Dasbor beban kerja dan ekspor

Menu **Beban kerja** (pemilik dan koordinator) menampilkan per anggota: kartu masuk/dikerjakan/ditinjau/tertahan, pemakaian WIP, terlambat, tenggat 7 hari, kartu disetujui dalam 7/30/90 hari, dan median hari sampai disetujui. Persetujuan yang dibatalkan tidak dihitung.

Ekspor CSV (UTF-8 dengan BOM, pilihan pemisah koma atau titik koma untuk Excel berbahasa Indonesia): daftar kartu (filter proyek dan status), riwayat kejadian (rentang tanggal, maksimal 366 hari), dan beban kerja. Sel yang bisa dibaca sebagai rumus diawali `'` untuk mencegah CSV injection. Setiap ekspor dicatat di audit log.

### Memperbarui VPS ke Fase 2

```
git pull
npm run migrate        # 002 (tanggal tinjau transfer) dan 003 (tabel Fase 2)
npm run gen-keys       # ambil baris VAPID_* saja, tempel ke .env
pm2 restart all
```

## Keamanan dan kepatuhan (ringkas)

- **Rahasia** hanya di `.env` pada VPS. Repo hanya berisi `.env.example` tanpa nilai.
- **Nomor WA dan isi pesan mentah** dienkripsi per kolom (AES-256-GCM). Pencarian nomor memakai blind index HMAC, sehingga nomor asli tidak pernah disimpan dalam bentuk teks.
- **Webhook**: tanda tangan HMAC diverifikasi pada body mentah dengan pembanding waktu-konstan, ditambah batas laju per nomor.
- **Web**: sesi berupa cookie `HttpOnly; Secure; SameSite=Strict`, CSRF memakai header kustom dan pemeriksaan Origin, CSP ketat tanpa skrip inline, dan RBAC per workspace (pemilik, koordinator, kolaborator, pemantau).
- **Tindakan berisiko** hanya bisa dari web: menghapus kartu, mengubah peran, retensi, ekspor, dan menghapus akun.
- **UU PDP / PP 33/2026**:
  - persetujuan eksplisit dan pemberitahuan transfer lintas negara saat bergabung;
  - register transfer data per workspace;
  - ekspor dan penghapusan data oleh subjek data;
  - audit log untuk setiap perubahan pengaturan.
- **Retensi**: isi pesan WA mentah dan media dihapus otomatis setiap hari setelah masa retensi workspace (bawaan 90 hari, dapat diatur 30–365 hari oleh pemilik). Id pesan dan hasil parsing tetap disimpan. Cadangan disimpan 30 hari bergulir.

## Perbedaan dari stack di dokumen rancangan

| Dokumen | Implementasi | Alasan |
| --- | --- | --- |
| NestJS atau Laravel | Node.js 22 tanpa framework (`node:http`) | Tanpa dependensi pihak ketiga selain driver `pg`, sehingga permukaan serangan dan perawatan lebih kecil |
| Redis + BullMQ | Antrean di tabel PostgreSQL (`SKIP LOCKED`) | Satu komponen lebih sedikit di VPS; tetap tahan banting dan idempoten |
| SvelteKit / Next.js + Workbox | HTML + JS modul tanpa build, service worker sendiri | PWA ringan untuk ponsel kelas menengah dan dapat dijalankan tanpa langkah build |
| MinIO / S3 | Belum. Lampiran WA dicatat sebagai metadata (id media, jenis, hash dari Meta) | Unduh, simpan ke object storage, dan pindai malware dijadwalkan setelah MVP |
| Grafana + Loki + Prometheus | Belum. Ada `/healthz` dan log aplikasi | Dijadwalkan setelah MVP |

## Struktur

```
src/
  server.js          HTTP: API, webhook, SSE, berkas statis
  app.js             penyusun komponen
  config.js          konfigurasi dari .env
  db/                adapter SQLite/PostgreSQL + migrasi
  domain/            reducer event, aturan transisi + hak akses, penulisan event
  wa/                parser perintah, webhook, pemroses pesan, pengirim
  push/              Web Push: enkripsi RFC 8291 + VAPID, langganan, pengiriman
  notify/            kebijakan push-first, notifikasi dari event log, ringkasan harian
  jobs/              antrean, worker, retensi
  auth/              OTP WhatsApp + sesi
  api/routes.js      endpoint JSON
  api/reports.js     dasbor beban kerja dan ekspor CSV
public/              PWA (index, app.js, offline.js, sw.js, manifest) + simulator /sim
scripts/             seed, create-owner, gen-keys
deploy/              Caddyfile, backup.sh
test/                uji node:test (unit, WhatsApp end-to-end, API HTTP)
```
