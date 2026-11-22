import { readFileSync, renameSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const names = [
  '001-initial', '002-owner-workflow', '003-merchants', '004-case-supplement',
  '005-staff-submission-photos', '006-published-feedback-photos', '007-collaboration-photos',
  '008-owner-supplement-photos', '009-wechat-receipt-codes', '010-public-submissions',
  '011-contact-access-audit', '012-supervision', '013-representative-reports',
  '014-tourism-events'
];

export function applyLegacyMigration(db, version) {
  const name = names[version - 1];
  if (!name) throw new RangeError('Unknown legacy fixture schema');
  db.exec(readFileSync(new URL(`../migrations/${name}.sql`, import.meta.url), 'utf8'));
}

export function applyLegacySchema(db, version) {
  for (let step = 1; step <= version; step++) applyLegacyMigration(db, step);
  db.exec(`PRAGMA user_version = ${version}`);
}

function identifier(value) {
  return '"' + value.replaceAll('"', '""') + '"';
}

// Copy API-seeded rows into a new, explicitly historical schema, preserving the receipt signature.
export function copyIntoLegacyFixture(sourcePath, targetPath, version) {
  const db = new DatabaseSync(targetPath);
  try {
    db.exec('PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE');
    applyLegacySchema(db, version);
    db.prepare('ATTACH DATABASE ? AS current_fixture').run(sourcePath);
    for (const {name} of db.prepare("SELECT name FROM main.sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()) {
      const table = identifier(name);
      const columns = db.prepare(`PRAGMA main.table_info(${table})`).all().map(column => identifier(column.name)).join(', ');
      db.exec(`INSERT INTO main.${table} (${columns}) SELECT ${columns} FROM current_fixture.${table}`);
    }
    if (db.prepare('PRAGMA main.foreign_key_check').get()) throw new Error('Invalid legacy fixture references');
    db.exec('COMMIT');
  } finally {
    db.close();
  }
}

export function replaceWithLegacyFixture(path, version) {
  const target = path + `.v${version}-fixture`;
  try {
    copyIntoLegacyFixture(path, target, version);
    renameSync(target, path);
  } finally {
    rmSync(target, {force:true});
  }
}
