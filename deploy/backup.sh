#!/usr/bin/env bash
# Backs up the Closer data directory: a consistent copy of the SQLite ledger made with SQLite's online
# backup API (safe while the server runs, WAL included), plus a tar of the uploaded photos. Both are
# named by date; backups older than 7 days are deleted.
#   bash deploy/backup.sh [DATA_DIR] [BACKUP_DIR]      defaults: /var/lib/closer  /var/backups/closer
# Run it as the user that owns the data directory (on the VM: closer), so no root-owned -wal/-shm
# file is left next to the ledger. deploy/gce/install_remote.sh installs it as closer-backup.timer.
set -euo pipefail
DATA_DIR="${1:-/var/lib/closer}"
BACKUP_DIR="${2:-/var/backups/closer}"
KEEP_DAYS="${CLOSER_BACKUP_KEEP_DAYS:-7}"
DB="$DATA_DIR/closer.db"
STAMP="$(date +%F)"
[ -f "$DB" ] || { echo "no database at $DB" >&2; exit 1; }
install -d -m 700 "$BACKUP_DIR"

# Ledger: the same online backup as `sqlite3 closer.db ".backup FILE"`, through node:sqlite (which
# the server already uses), so the VM needs no extra package.
node --disable-warning=ExperimentalWarning -e '
  const { DatabaseSync, backup } = require("node:sqlite");
  const [src, dest] = process.argv.slice(1);
  const db = new DatabaseSync(src);
  backup(db, dest)
    .then((pages) => { db.close(); console.log(`ledger: ${pages} pages copied to ${dest}`); })
    .catch((e) => { console.error(`ledger backup failed: ${e.message}`); process.exit(1); });
' "$DB" "$BACKUP_DIR/closer-$STAMP.db.part"
mv -f "$BACKUP_DIR/closer-$STAMP.db.part" "$BACKUP_DIR/closer-$STAMP.db"

# Photos: the uploaded JPEG/PNG pairs next to the database (store/photos.ts).
if [ -d "$DATA_DIR/photos" ]; then
  tar -czf "$BACKUP_DIR/photos-$STAMP.tgz.part" -C "$DATA_DIR" photos
  mv -f "$BACKUP_DIR/photos-$STAMP.tgz.part" "$BACKUP_DIR/photos-$STAMP.tgz"
  echo "photos: $(find "$DATA_DIR/photos" -type f | wc -l) files in photos-$STAMP.tgz"
fi

# Rotation: keep the last KEEP_DAYS daily backups.
find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'closer-*.db' -o -name 'photos-*.tgz' \) -mtime "+$((KEEP_DAYS - 1))" -delete
echo "backup $STAMP written to $BACKUP_DIR"
