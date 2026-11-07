# Kolab-Hub — catatan untuk agen

- Model kerja: PICO (github.com/ipalalloi/PICO), versi terbaru yang terpasang. Proyek: WA Colaborator.
- Wadah: repo ipalalloi/kolab-hub (privat). Kerja di cabang fitur, uji dijalankan dan dibaca, lalu PR terpisah per fase.
- Sumber rancangan: dokumen "Kajian & Rancangan Sistem Kolaborasi Web + PWA + WhatsApp" (FINAL 7 Nov 2026).
- Uji: `npm test` (Node 22, tanpa dependensi; memakai SQLite memori). Produksi memakai PostgreSQL lewat paket `pg`.
- Jangan pernah menulis kredensial (kunci BSP, App Secret Meta, token) di kode, repo, atau chat; hanya di `.env` pada VPS.
- Event log dan audit log append-only: koreksi = event baru (`event.reverted`), jangan ubah atau hapus baris.
- Bahasa antarmuka dan pesan: Indonesia.
