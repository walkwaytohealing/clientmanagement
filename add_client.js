const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'php_clients.db');
const db = new sqlite3.Database(dbPath);

// Convert JS Date to Excel serial date
function jsDateToExcelDate(date) {
  const excelEpoch = new Date(1899, 11, 30);
  const diffTime = date - excelEpoch;
  return Math.floor(diffTime / (24 * 60 * 60 * 1000));
}

// Today's date: March 18, 2026
const today = new Date(2026, 2, 18); // Month is 0-indexed
const intakeSerial = jsDateToExcelDate(today);

// Calculate milestone dates
const day28 = new Date(2026, 2, 18 + 28);
const day45 = new Date(2026, 2, 18 + 45);
const day60 = new Date(2026, 2, 18 + 60);

const day28Serial = jsDateToExcelDate(day28);
const day45Serial = jsDateToExcelDate(day45);
const day60Serial = jsDateToExcelDate(day60);

console.log('Adding Alex Holzman to database...');
console.log('Intake date (Excel serial):', intakeSerial);
console.log('Day 28:', day28Serial, '(', day28.toISOString().split('T')[0], ')');
console.log('Day 45:', day45Serial, '(', day45.toISOString().split('T')[0], ')');
console.log('Day 60:', day60Serial, '(', day60.toISOString().split('T')[0], ')');

db.run(
  `INSERT INTO clients (name, house, intake_date, day_28, day_45, day_60, location, meeting_iop, comments, status) 
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [
    'Alex Holzman',
    'Light St',
    intakeSerial,
    day28Serial,
    day45Serial,
    day60Serial,
    '',
    '',
    'Intake: March 18, 2026',
    'active'
  ],
  function(err) {
    if (err) {
      console.error('Error adding client:', err);
      db.close();
      process.exit(1);
    }
    console.log('✓ Alex Holzman added successfully with ID:', this.lastID);
    
    // Verify the insertion
    db.get('SELECT * FROM clients WHERE id = ?', [this.lastID], (err, row) => {
      if (err) {
        console.error('Error verifying:', err);
      } else {
        console.log('Verified entry:', row);
      }
      db.close();
    });
  }
);
