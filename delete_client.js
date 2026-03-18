const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'php_clients.db');
const db = new sqlite3.Database(dbPath);

console.log('Searching for Alex Holzman...');

db.get('SELECT id, name FROM clients WHERE name LIKE ?', ['%Alex Holzman%'], (err, row) => {
  if (err) {
    console.error('Error searching:', err);
    db.close();
    process.exit(1);
  }
  
  if (!row) {
    console.log('Alex Holzman not found in database.');
    db.close();
    process.exit(0);
  }
  
  console.log('Found:', row.name, '(ID:', row.id + ')');
  
  db.run('DELETE FROM clients WHERE id = ?', [row.id], function(err) {
    if (err) {
      console.error('Error deleting:', err);
      db.close();
      process.exit(1);
    }
    
    console.log('✓ Deleted successfully. Rows affected:', this.changes);
    db.close();
  });
});
