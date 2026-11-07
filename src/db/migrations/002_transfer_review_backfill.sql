-- Perbaikan uji VPS: workspace yang dibuat lewat `npm run create-owner` (sebelum perbaikan ini)
-- tersimpan tanpa tanggal tinjau register transfer. Isi satu tahun sejak baris dibuat,
-- sama seperti workspace yang dibuat lewat web. Baris yang sudah punya tanggal tidak disentuh.

-- @sqlite
UPDATE data_transfers SET next_review = date(created_at, '+365 days') WHERE next_review IS NULL;

-- @pg
UPDATE data_transfers SET next_review = to_char((created_at::timestamptz + interval '365 days'), 'YYYY-MM-DD') WHERE next_review IS NULL;
