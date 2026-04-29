const Database = require('better-sqlite3');
const db = new Database('c:/Users/Piotr/Desktop/GEMINI/zykubek/sample.gpkg', { readonly: true });
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
for (let t of tables) {
  if (t.name.startsWith('sqlite_') || t.name.startsWith('gpkg_') || t.name.startsWith('rtree_')) continue;
  try {
    const rows = db.prepare('SELECT * FROM "' + t.name + '" LIMIT 50').all();
    if (rows.length > 0) {
      for (const row of rows) {
        for (const [k, v] of Object.entries(row)) {
          if (typeof v === 'string' && (v.includes('X/0400') || v.includes('0400'))) {
            console.log('Found in table:', t.name, ' column:', k, ' value:', v);
          }
        }
      }
    }
  } catch (e) {}
}
