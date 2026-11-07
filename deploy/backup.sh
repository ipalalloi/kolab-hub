#!/usr/bin/env sh
# Cadangan harian terenkripsi PostgreSQL, disimpan 30 hari bergulir (Aturan retensi FINAL).
# Pasang di crontab VPS:  15 2 * * *  /opt/kolab-hub/deploy/backup.sh >> /var/log/kolab-backup.log 2>&1
# BACKUP_PASSPHRASE dibaca dari .env; simpan salinannya di pengelola kata sandi, bukan di repo.
set -eu
cd "$(dirname "$0")/.."
# set -a: semua variabel dari .env diekspor, termasuk BACKUP_PASSPHRASE yang dibaca openssl lewat -pass env:
set -a
. ./.env
set +a
: "${BACKUP_PASSPHRASE:?isi BACKUP_PASSPHRASE di .env}"
DEST="${BACKUP_DIR:-/var/backups/kolab}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-30}"
mkdir -p "$DEST"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FINAL="$DEST/kolab-$STAMP.dump.enc"
PART="$FINAL.partial"
STATUS="$(mktemp)"
trap 'rm -f "$PART" "$STATUS"' EXIT
# sh tidak punya pipefail: status pg_dump dicatat terpisah agar kegagalannya tidak tertutup openssl.
{ rc=0; docker compose exec -T db pg_dump -U kolab -d kolab --format=custom || rc=$?; echo "$rc" > "$STATUS"; } \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_PASSPHRASE > "$PART"
if [ "$(cat "$STATUS")" != "0" ]; then
  echo "GAGAL: pg_dump keluar dengan status $(cat "$STATUS"); cadangan lama tidak dirotasi" >&2
  exit 1
fi
# Pastikan berkas bisa didekripsi dan berisi arsip pg_dump (diawali "PGDMP").
if ! openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$PART" 2>/dev/null | head -c 5 | grep -q PGDMP; then
  echo "GAGAL: hasil cadangan kosong atau tidak valid; cadangan lama tidak dirotasi" >&2
  exit 1
fi
mv "$PART" "$FINAL"
# Rotasi hanya setelah cadangan baru terbukti utuh.
find "$DEST" -name 'kolab-*.dump.enc' -mtime +"$KEEP_DAYS" -delete
echo "cadangan $STAMP selesai ($(wc -c < "$FINAL") byte)"
# Pemulihan (uji bulanan):
#   openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in FILE | docker compose exec -T db pg_restore -U kolab -d kolab_uji
