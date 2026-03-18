const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();

const PORT = 3456;
const PASSWORD_HASH = crypto.createHash('sha256').update('Walkway25').digest('hex');
const SESSION_TIMEOUT = 8 * 60 * 60 * 1000; // 8 hours

// Initialize SQLite database
const dbPath = path.join(__dirname, 'php_clients.db');
const db = new sqlite3.Database(dbPath);

// Create tables
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    house TEXT NOT NULL,
    intake_date INTEGER,
    day_28 INTEGER,
    day_45 INTEGER,
    day_60 INTEGER,
    location TEXT,
    meeting_iop TEXT,
    comments TEXT,
    status TEXT DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER,
    reminder_date INTEGER,
    reminder_type TEXT,
    notes TEXT,
    completed BOOLEAN DEFAULT 0,
    FOREIGN KEY (client_id) REFERENCES clients(id)
  )`);
});

// Excel date serial to JS Date (Excel epoch is 1900-01-00, but has 1900 leap year bug)
function excelDateToJSDate(serial) {
  if (!serial || typeof serial !== 'number') return null;
  // Excel's epoch starts at 1900-01-00, but we need to account for the 1900 leap year bug
  // Excel thinks 1900 was a leap year (it wasn't), so dates after Feb 28, 1900 are off by 1
  const excelEpoch = new Date(1899, 11, 30); // Dec 30, 1899
  const days = Math.floor(serial);
  const ms = days * 24 * 60 * 60 * 1000;
  return new Date(excelEpoch.getTime() + ms);
}

function formatDate(date) {
  if (!date) return '';
  return date.toISOString().split('T')[0];
}

function getDaysInProgram(intakeDate) {
  if (!intakeDate) return 0;
  const today = new Date();
  const diffTime = today - intakeDate;
  return Math.floor(diffTime / (1000 * 60 * 60 * 24));
}

// Import data from Excel
function importExcelData() {
  const xlsx = require('xlsx');
  const wb = xlsx.readFile('C:\\Users\\think\\Downloads\\Copy of Transitions.xlsm.xlsx');
  const ws = wb.Sheets[wb.SheetNames[0]];
  const data = xlsx.utils.sheet_to_json(ws, {header:1});
  
  // Skip header row and empty rows
  const clients = [];
  for (let i = 2; i < data.length; i++) {
    const row = data[i];
    if (!row[1] || !row[2]) continue; // Skip rows without client name or intake date
    
    const client = {
      house: row[0] || 'Light St',
      name: row[1],
      intake_date: row[2] ? Math.floor(row[2]) : null,
      day_28: row[3] ? Math.floor(row[3]) : null,
      day_45: row[4] ? Math.floor(row[4]) : null,
      day_60: row[5] ? Math.floor(row[5]) : null,
      location: row[6] || '',
      meeting_iop: row[7] ? String(row[7]) : '',
      comments: row[8] ? String(row[8]) : ''
    };
    clients.push(client);
  }
  
  return clients;
}

// Decrypt and load embedded client data
function loadEncryptedData() {
  try {
    const encryptedFile = path.join(__dirname, 'clients.enc');
    if (!fs.existsSync(encryptedFile)) {
      console.log('No encrypted data file found');
      return null;
    }
    
    const key = process.env.ENCRYPTION_KEY;
    const iv = process.env.ENCRYPTION_IV;
    
    if (!key || !iv) {
      console.log('No encryption keys found in environment');
      return null;
    }
    
    const encrypted = fs.readFileSync(encryptedFile, 'utf8');
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(key, 'hex'), Buffer.from(iv, 'hex'));
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return JSON.parse(decrypted);
  } catch (err) {
    console.error('Failed to decrypt data:', err.message);
    return null;
  }
}

// Populate database with encrypted data or Excel data
function populateDatabase() {
  // First try encrypted data (for production)
  const encryptedClients = loadEncryptedData();
  if (encryptedClients && encryptedClients.length > 0) {
    console.log(`Loading ${encryptedClients.length} clients from encrypted store...`);
    
    db.get('SELECT COUNT(*) as count FROM clients', (err, row) => {
      if (err || row.count > 0) {
        console.log('Database already has data, skipping import');
        return;
      }
      
      const stmt = db.prepare(`INSERT INTO clients 
        (name, house, intake_date, day_28, day_45, day_60, location, meeting_iop, comments) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      
      encryptedClients.forEach(client => {
        stmt.run(
          client.name,
          client.house,
          client.intake_date,
          client.day_28,
          client.day_45,
          client.day_60,
          client.location,
          client.meeting_iop,
          client.comments
        );
      });
      
      stmt.finalize();
      console.log(`Imported ${encryptedClients.length} clients from encrypted store`);
    });
    return;
  }
  
  // Fall back to Excel (for local development only)
  const excelPath = 'C:\\Users\\think\\Downloads\\Copy of Transitions.xlsm.xlsx';
  if (!fs.existsSync(excelPath)) {
    console.log('No data source found. Starting with empty database.');
    return;
  }
  
  const clients = importExcelData();
  
  db.run('DELETE FROM clients');
  db.run('DELETE FROM reminders');
  
  const stmt = db.prepare(`INSERT INTO clients 
    (name, house, intake_date, day_28, day_45, day_60, location, meeting_iop, comments) 
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  
  clients.forEach(client => {
    stmt.run(
      client.name,
      client.house,
      client.intake_date,
      client.day_28,
      client.day_45,
      client.day_60,
      client.location,
      client.meeting_iop,
      client.comments
    );
  });
  
  stmt.finalize();
  console.log(`Imported ${clients.length} clients from Excel`);
}

// Auth middleware
function checkAuth(req, res) {
  const cookies = parseCookies(req);
  const token = cookies.session;
  
  if (!token) {
    res.writeHead(302, { Location: '/login' });
    res.end();
    return false;
  }
  
  return new Promise((resolve) => {
    db.get('SELECT * FROM sessions WHERE token = ?', [token], (err, row) => {
      if (err || !row) {
        res.writeHead(302, { Location: '/login' });
        res.end();
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
}

function parseCookies(req) {
  const cookies = {};
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    cookieHeader.split(';').forEach(cookie => {
      const [name, value] = cookie.trim().split('=');
      cookies[name] = value;
    });
  }
  return cookies;
}

// HTML Templates
const loginPage = `<!DOCTYPE html>
<html>
<head>
  <title>Walkway PHP - Login</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .login-box {
      background: white;
      padding: 40px;
      border-radius: 12px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      width: 100%;
      max-width: 400px;
    }
    h1 { color: #1a1a2e; margin-bottom: 10px; font-size: 24px; }
    .subtitle { color: #666; margin-bottom: 30px; }
    input {
      width: 100%;
      padding: 14px;
      margin-bottom: 20px;
      border: 2px solid #e0e0e0;
      border-radius: 8px;
      font-size: 16px;
      transition: border-color 0.3s;
      -webkit-appearance: none;
    }
    input:focus { outline: none; border-color: #4a90d9; }
    button {
      width: 100%;
      padding: 14px;
      background: #4a90d9;
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.3s;
      -webkit-appearance: none;
      touch-action: manipulation;
    }
    button:hover { background: #357abd; }
    button:active { transform: scale(0.98); }
    .error { color: #e74c3c; margin-top: 15px; text-align: center; }
    
    @media (max-width: 480px) {
      body { padding: 15px; }
      .login-box { padding: 30px 20px; }
      h1 { font-size: 22px; }
      .subtitle { font-size: 14px; }
      input, button { font-size: 16px; padding: 12px; }
    }
  </style>
</head>
<body>
  <div class="login-box">
    <h1>Walkway PHP</h1>
    <p class="subtitle">Client Management System</p>
    <form method="POST" action="/login">
      <input type="password" name="password" placeholder="Enter password" required autofocus>
      <button type="submit">Sign In</button>
    </form>
    {{ERROR}}
  </div>
</body>
</html>`;

const mainPage = `<!DOCTYPE html>
<html>
<head>
  <title>Walkway PHP - Dashboard</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f5f7fa;
      min-height: 100vh;
      -webkit-text-size-adjust: 100%;
    }
    .header {
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      color: white;
      padding: 15px 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 10px;
    }
    .header h1 { font-size: 20px; white-space: nowrap; }
    .header .nav { display: flex; gap: 15px; align-items: center; }
    .header a { color: white; text-decoration: none; opacity: 0.8; font-size: 14px; }
    .header a:hover { opacity: 1; }
    .container { padding: 15px; max-width: 1400px; margin: 0 auto; }
    .stats {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 10px;
      margin-bottom: 15px;
    }
    .stat-card {
      background: white;
      padding: 15px;
      border-radius: 10px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.08);
    }
    .stat-card h3 { color: #666; font-size: 11px; text-transform: uppercase; margin-bottom: 8px; }
    .stat-card .number { font-size: 24px; font-weight: 700; color: #1a1a2e; }
    .stat-card.active .number { color: #27ae60; }
    .stat-card.meetings .number { color: #e74c3c; }
    .filters {
      background: white;
      padding: 15px;
      border-radius: 10px;
      margin-bottom: 15px;
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      align-items: center;
    }
    .filters input, .filters select {
      padding: 10px 12px;
      border: 2px solid #e0e0e0;
      border-radius: 8px;
      font-size: 14px;
      flex: 1;
      min-width: 140px;
      -webkit-appearance: none;
    }
    .filters input:focus, .filters select:focus { outline: none; border-color: #4a90d9; }
    .btn {
      padding: 10px 16px;
      background: #4a90d9;
      color: white;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      font-size: 14px;
      text-decoration: none;
      display: inline-block;
      touch-action: manipulation;
      -webkit-appearance: none;
    }
    .btn:hover { background: #357abd; }
    .btn:active { transform: scale(0.98); }
    .btn-success { background: #27ae60; }
    .btn-success:hover { background: #219a52; }
    .table-container {
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
      background: white;
      border-radius: 10px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.08);
    }
    table {
      width: 100%;
      min-width: 800px;
      border-collapse: collapse;
      font-size: 13px;
    }
    th {
      background: #1a1a2e;
      color: white;
      padding: 12px 10px;
      text-align: left;
      font-weight: 600;
      font-size: 11px;
      text-transform: uppercase;
      white-space: nowrap;
    }
    td {
      padding: 12px 10px;
      border-bottom: 1px solid #eee;
    }
    tr:hover { background: #f8f9fa; }
    .days-badge {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 20px;
      font-size: 11px;
      font-weight: 600;
      white-space: nowrap;
    }
    .days-early { background: #d4edda; color: #155724; }
    .days-mid { background: #fff3cd; color: #856404; }
    .days-late { background: #f8d7da; color: #721c24; }
    .meeting-soon { background: #e74c3c; color: white; }
    .comment-cell {
      max-width: 150px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .actions { display: flex; gap: 8px; }
    .actions a { 
      color: #4a90d9; 
      text-decoration: none; 
      padding: 6px 12px;
      border: 1px solid #4a90d9;
      border-radius: 6px;
      font-size: 12px;
    }
    .actions a:hover { background: #4a90d9; color: white; }
    .empty-state {
      text-align: center;
      padding: 40px;
      color: #666;
    }
    
    @media (min-width: 768px) {
      .header { padding: 20px 30px; }
      .header h1 { font-size: 24px; }
      .header a { font-size: 16px; }
      .container { padding: 30px; }
      .stats {
        grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
        gap: 20px;
        margin-bottom: 30px;
      }
      .stat-card { padding: 25px; }
      .stat-card h3 { font-size: 14px; }
      .stat-card .number { font-size: 36px; }
      .filters { padding: 20px; margin-bottom: 20px; }
      .filters input, .filters select { min-width: auto; }
      .btn { padding: 10px 20px; }
      table { min-width: auto; font-size: 14px; }
      th { padding: 15px; font-size: 13px; }
      td { padding: 15px; }
      .days-badge { padding: 5px 12px; font-size: 12px; }
      .comment-cell { max-width: 200px; }
    }
    
    @media (max-width: 480px) {
      .header h1 { font-size: 16px; }
      .header .nav { gap: 10px; }
      .header a { font-size: 12px; }
      .stats { grid-template-columns: repeat(2, 1fr); }
      .stat-card { padding: 12px; }
      .stat-card h3 { font-size: 10px; }
      .stat-card .number { font-size: 20px; }
      .filters input, .filters select { font-size: 16px; }
      .btn { font-size: 14px; padding: 10px 14px; }
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>Walkway PHP - Client Management</h1>
    <div class="nav">
      <a href="/">Dashboard</a>
      <a href="/reminders">Reminders</a>
      <a href="/logout">Logout</a>
    </div>
  </div>
  <div class="container">
    <div class="stats">
      <div class="stat-card">
        <h3>Total Clients</h3>
        <div class="number">{{TOTAL}}</div>
      </div>
      <div class="stat-card active">
        <h3>Active Clients</h3>
        <div class="number">{{ACTIVE}}</div>
      </div>
      <div class="stat-card meetings">
        <h3>Meetings Today</h3>
        <div class="number">{{MEETINGS}}</div>
      </div>
      <div class="stat-card">
        <h3>Avg Days in Program</h3>
        <div class="number">{{AVG_DAYS}}</div>
      </div>
    </div>
    
    <div class="filters">
      <input type="text" id="search" placeholder="Search clients..." onkeyup="filterTable()">
      <select id="houseFilter" onchange="filterTable()">
        <option value="">All Houses</option>
        <option value="Light St">Light St</option>
      </select>
      <select id="statusFilter" onchange="filterTable()">
        <option value="">All Status</option>
        <option value="active">Active</option>
        <option value="completed">Completed</option>
      </select>
      <a href="/client/new" class="btn btn-success">+ Add Client</a>
    </div>
    
    <div class="table-container">
      <table id="clientsTable">
        <thead>
          <tr>
            <th>Client</th>
            <th>House</th>
            <th>Intake</th>
            <th>Days</th>
            <th>28 Day</th>
            <th>45 Day</th>
            <th>60 Day</th>
            <th>Location</th>
            <th>Meeting</th>
            <th>Notes</th>
            <th>Edit</th>
          </tr>
        </thead>
        <tbody>
          {{CLIENT_ROWS}}
        </tbody>
      </table>
    </div>
  </div>
  
  <script>
    function filterTable() {
      const search = document.getElementById('search').value.toLowerCase();
      const house = document.getElementById('houseFilter').value;
      const status = document.getElementById('statusFilter').value;
      const rows = document.querySelectorAll('#clientsTable tbody tr');
      
      rows.forEach(row => {
        const text = row.textContent.toLowerCase();
        const rowHouse = row.dataset.house;
        const rowStatus = row.dataset.status;
        
        const matchesSearch = text.includes(search);
        const matchesHouse = !house || rowHouse === house;
        const matchesStatus = !status || rowStatus === status;
        
        row.style.display = matchesSearch && matchesHouse && matchesStatus ? '' : 'none';
      });
    }
  </script>
</body>
</html>`;

// Generate client rows HTML
function generateClientRows(clients) {
  if (clients.length === 0) {
    return '<tr><td colspan="11" class="empty-state">No clients found</td></tr>';
  }
  
  const today = new Date();
  const todaySerial = Math.floor((today - new Date(1899, 11, 30)) / (24 * 60 * 60 * 1000));
  
  return clients.map(c => {
    const intakeDate = c.intake_date ? excelDateToJSDate(c.intake_date) : null;
    const day28 = c.day_28 ? excelDateToJSDate(c.day_28) : null;
    const day45 = c.day_45 ? excelDateToJSDate(c.day_45) : null;
    const day60 = c.day_60 ? excelDateToJSDate(c.day_60) : null;
    
    const daysIn = intakeDate ? getDaysInProgram(intakeDate) : 0;
    let daysClass = 'days-early';
    if (daysIn >= 20) daysClass = 'days-mid';
    if (daysIn >= 28) daysClass = 'days-late';
    
    // Check if meeting is coming up (within 3 days)
    let meetingClass = '';
    let meetingText = c.meeting_iop || '';
    if (c.meeting_iop && !isNaN(parseInt(c.meeting_iop))) {
      const meetingDate = parseInt(c.meeting_iop);
      const daysUntil = meetingDate - todaySerial;
      if (daysUntil >= 0 && daysUntil <= 3) {
        meetingClass = 'meeting-soon';
        meetingText = `Day ${meetingDate} (in ${daysUntil} days)`;
      }
    }
    
    return `
      <tr data-house="${c.house}" data-status="${c.status}">
        <td><strong>${c.name}</strong></td>
        <td>${c.house}</td>
        <td>${formatDate(intakeDate)}</td>
        <td><span class="days-badge ${daysClass}">${daysIn} days</span></td>
        <td>${formatDate(day28)}</td>
        <td>${formatDate(day45)}</td>
        <td>${formatDate(day60)}</td>
        <td>${c.location || ''}</td>
        <td><span class="days-badge ${meetingClass}">${meetingText}</span></td>
        <td class="comment-cell" title="${c.comments || ''}">${c.comments || ''}</td>
        <td class="actions">
          <a href="/client/${c.id}">Edit</a>
        </td>
      </tr>
    `;
  }).join('');
}

// JS Date to Excel serial
function jsDateToExcelDate(date) {
  if (!date) return null;
  const excelEpoch = new Date(1899, 11, 30);
  const diffTime = date - excelEpoch;
  return Math.floor(diffTime / (24 * 60 * 60 * 1000));
}

// Edit client page template
const editClientPage = `<!DOCTYPE html>
<html>
<head>
  <title>{{TITLE}} - Walkway PHP</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f5f7fa;
      min-height: 100vh;
      -webkit-text-size-adjust: 100%;
    }
    .header {
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      color: white;
      padding: 15px 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 10px;
    }
    .header h1 { font-size: 18px; white-space: nowrap; }
    .header .nav { display: flex; gap: 15px; align-items: center; }
    .header a { color: white; text-decoration: none; opacity: 0.8; font-size: 14px; }
    .header a:hover { opacity: 1; }
    .container { padding: 15px; max-width: 800px; margin: 0 auto; }
    .card {
      background: white;
      padding: 20px;
      border-radius: 12px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.08);
    }
    .card h2 { margin-bottom: 20px; color: #1a1a2e; font-size: 20px; }
    .form-group {
      margin-bottom: 15px;
    }
    .form-group label {
      display: block;
      margin-bottom: 6px;
      font-weight: 600;
      color: #333;
      font-size: 14px;
    }
    .form-group input,
    .form-group select,
    .form-group textarea {
      width: 100%;
      padding: 12px;
      border: 2px solid #e0e0e0;
      border-radius: 8px;
      font-size: 16px;
      font-family: inherit;
      -webkit-appearance: none;
    }
    .form-group input:focus,
    .form-group select:focus,
    .form-group textarea:focus {
      outline: none;
      border-color: #4a90d9;
    }
    .form-group textarea {
      min-height: 80px;
      resize: vertical;
    }
    .form-row {
      display: grid;
      grid-template-columns: 1fr;
      gap: 15px;
    }
    .btn {
      padding: 12px 20px;
      background: #4a90d9;
      color: white;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      font-size: 16px;
      font-weight: 600;
      touch-action: manipulation;
      -webkit-appearance: none;
      width: 100%;
      text-align: center;
      text-decoration: none;
      display: inline-block;
    }
    .btn:hover { background: #357abd; }
    .btn:active { transform: scale(0.98); }
    .btn-success { background: #27ae60; }
    .btn-success:hover { background: #219a52; }
    .btn-danger { background: #e74c3c; }
    .btn-danger:hover { background: #c0392b; }
    .btn-secondary { background: #95a5a6; }
    .btn-secondary:hover { background: #7f8c8d; }
    .actions {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-top: 25px;
      padding-top: 20px;
      border-top: 1px solid #eee;
    }
    .error {
      background: #f8d7da;
      color: #721c24;
      padding: 12px;
      border-radius: 8px;
      margin-bottom: 15px;
      font-size: 14px;
    }
    .success {
      background: #d4edda;
      color: #155724;
      padding: 12px;
      border-radius: 8px;
      margin-bottom: 15px;
      font-size: 14px;
    }
    .date-note {
      font-size: 12px;
      color: #666;
      margin-top: 4px;
    }
    .danger-zone {
      margin-top: 25px;
      padding: 15px;
      background: #fdf2f2;
      border: 1px solid #f5c6cb;
      border-radius: 8px;
    }
    .danger-zone h3 {
      color: #721c24;
      margin-bottom: 8px;
      font-size: 16px;
    }
    .danger-zone p {
      font-size: 14px;
      color: #666;
    }
    
    @media (min-width: 768px) {
      .header { padding: 20px 30px; }
      .header h1 { font-size: 24px; }
      .header a { font-size: 16px; }
      .container { padding: 30px; }
      .card { padding: 30px; }
      .card h2 { font-size: 24px; margin-bottom: 25px; }
      .form-group { margin-bottom: 20px; }
      .form-group label { font-size: 16px; }
      .form-row { grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; }
      .actions { flex-direction: row; gap: 15px; }
      .btn { width: auto; padding: 12px 30px; }
    }
    
    @media (max-width: 480px) {
      .header h1 { font-size: 16px; }
      .card { padding: 15px; }
      .card h2 { font-size: 18px; }
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>Walkway PHP - {{TITLE}}</h1>
    <div class="nav">
      <a href="/">Dashboard</a>
      <a href="/logout">Logout</a>
    </div>
  </div>
  <div class="container">
    <div class="card">
      {{MESSAGE}}
      <form method="POST" action="{{ACTION}}">
        <div class="form-group">
          <label for="name">Client Name *</label>
          <input type="text" id="name" name="name" value="{{NAME}}" required>
        </div>
        
        <div class="form-row">
          <div class="form-group">
            <label for="house">House</label>
            <select id="house" name="house">
              <option value="Light St" {{HOUSE_LIGHT}}>Light St</option>
              <option value="Other" {{HOUSE_OTHER}}>Other</option>
            </select>
          </div>
          
          <div class="form-group">
            <label for="status">Status</label>
            <select id="status" name="status">
              <option value="active" {{STATUS_ACTIVE}}>Active</option>
              <option value="completed" {{STATUS_COMPLETED}}>Completed</option>
              <option value="discharged" {{STATUS_DISCHARGED}}>Discharged</option>
            </select>
          </div>
        </div>
        
        <div class="form-group">
          <label for="intake_date">Intake Date</label>
          <input type="date" id="intake_date" name="intake_date" value="{{INTAKE_DATE}}">
          <p class="date-note">Program days will be calculated automatically from this date</p>
        </div>
        
        <div class="form-row">
          <div class="form-group">
            <label for="day_28">28 Day Date</label>
            <input type="date" id="day_28" name="day_28" value="{{DAY_28}}">
          </div>
          <div class="form-group">
            <label for="day_45">45 Day Date</label>
            <input type="date" id="day_45" name="day_45" value="{{DAY_45}}">
          </div>
          <div class="form-group">
            <label for="day_60">60 Day Date</label>
            <input type="date" id="day_60" name="day_60" value="{{DAY_60}}">
          </div>
        </div>
        
        <div class="form-group">
          <label for="location">Current Location</label>
          <input type="text" id="location" name="location" value="{{LOCATION}}" placeholder="e.g., Hillcrest, Bibble, Home">
        </div>
        
        <div class="form-group">
          <label for="meeting_iop">Meeting/IOP Date</label>
          <input type="text" id="meeting_iop" name="meeting_iop" value="{{MEETING_IOP}}" placeholder="Day number or date">
          <p class="date-note">Enter a day number (e.g., "46104") or leave notes about meeting schedule</p>
        </div>
        
        <div class="form-group">
          <label for="comments">Comments/Notes</label>
          <textarea id="comments" name="comments" placeholder="Add any notes about this client...">{{COMMENTS}}</textarea>
        </div>
        
        <div class="actions">
          <button type="submit" class="btn btn-success">Save Client</button>
          <a href="/" class="btn btn-secondary">Cancel</a>
        </div>
      </form>
      
      {{DELETE_SECTION}}
    </div>
  </div>
</body>
</html>`;

// HTTP Server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;
  const method = req.method;
  
  // Static files
  if (pathname === '/login') {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        const params = new URLSearchParams(body);
        const password = params.get('password');
        const hash = crypto.createHash('sha256').update(password).digest('hex');
        
        if (hash === PASSWORD_HASH) {
          const token = crypto.randomBytes(32).toString('hex');
          db.run('INSERT INTO sessions (token) VALUES (?)', [token]);
          res.writeHead(302, { 
            'Location': '/',
            'Set-Cookie': `session=${token}; HttpOnly; Path=/; Max-Age=${SESSION_TIMEOUT/1000}`
          });
          res.end();
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(loginPage.replace('{{ERROR}}', '<p class="error">Invalid password</p>'));
        }
      });
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(loginPage.replace('{{ERROR}}', ''));
    }
    return;
  }
  
  if (pathname === '/logout') {
    const cookies = parseCookies(req);
    if (cookies.session) {
      db.run('DELETE FROM sessions WHERE token = ?', [cookies.session]);
    }
    res.writeHead(302, { 
      'Location': '/login',
      'Set-Cookie': 'session=; HttpOnly; Path=/; Max-Age=0'
    });
    res.end();
    return;
  }
  
  // Protected routes
  const isAuthed = await checkAuth(req, res);
  if (!isAuthed) return;
  
  if (pathname === '/') {
    db.all('SELECT * FROM clients WHERE status = "active" ORDER BY intake_date ASC', (err, clients) => {
      if (err) {
        res.writeHead(500);
        res.end('Database error');
        return;
      }
      
      const today = new Date();
      const todaySerial = Math.floor((today - new Date(1899, 11, 30)) / (24 * 60 * 60 * 1000));
      
      // Calculate stats
      const total = clients.length;
      const active = clients.filter(c => c.status === 'active').length;
      const meetingsToday = clients.filter(c => {
        if (!c.meeting_iop) return false;
        const meetingDate = parseInt(c.meeting_iop);
        return meetingDate === todaySerial;
      }).length;
      
      const avgDays = clients.length > 0 
        ? Math.round(clients.reduce((sum, c) => {
            const intake = c.intake_date ? excelDateToJSDate(c.intake_date) : null;
            return sum + (intake ? getDaysInProgram(intake) : 0);
          }, 0) / clients.length)
        : 0;
      
      let html = mainPage
        .replace('{{TOTAL}}', total)
        .replace('{{ACTIVE}}', active)
        .replace('{{MEETINGS}}', meetingsToday)
        .replace('{{AVG_DAYS}}', avgDays)
        .replace('{{CLIENT_ROWS}}', generateClientRows(clients));
      
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    });
    return;
  }
  
  if (pathname === '/api/clients') {
    db.all('SELECT * FROM clients ORDER BY intake_date ASC', (err, clients) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Database error' }));
        return;
      }
      
      const formatted = clients.map(c => ({
        ...c,
        intake_date_formatted: c.intake_date ? formatDate(excelDateToJSDate(c.intake_date)) : null,
        day_28_formatted: c.day_28 ? formatDate(excelDateToJSDate(c.day_28)) : null,
        day_45_formatted: c.day_45 ? formatDate(excelDateToJSDate(c.day_45)) : null,
        day_60_formatted: c.day_60 ? formatDate(excelDateToJSDate(c.day_60)) : null,
        days_in_program: c.intake_date ? getDaysInProgram(excelDateToJSDate(c.intake_date)) : 0
      }));
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(formatted));
    });
    return;
  }
  
  // New client form
  if (pathname === '/client/new') {
    if (method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        const params = new URLSearchParams(body);
        
        const intakeDate = params.get('intake_date') ? jsDateToExcelDate(new Date(params.get('intake_date'))) : null;
        const day28 = params.get('day_28') ? jsDateToExcelDate(new Date(params.get('day_28'))) : null;
        const day45 = params.get('day_45') ? jsDateToExcelDate(new Date(params.get('day_45'))) : null;
        const day60 = params.get('day_60') ? jsDateToExcelDate(new Date(params.get('day_60'))) : null;
        
        db.run(`INSERT INTO clients 
          (name, house, status, intake_date, day_28, day_45, day_60, location, meeting_iop, comments) 
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            params.get('name'),
            params.get('house'),
            params.get('status'),
            intakeDate,
            day28,
            day45,
            day60,
            params.get('location'),
            params.get('meeting_iop'),
            params.get('comments')
          ],
          function(err) {
            if (err) {
              res.writeHead(500);
              res.end('Error saving client');
              return;
            }
            res.writeHead(302, { Location: '/' });
            res.end();
          }
        );
      });
      return;
    }
    
    // Show new client form
    let html = editClientPage
      .replace(/{{TITLE}}/g, 'Add New Client')
      .replace('{{ACTION}}', '/client/new')
      .replace('{{NAME}}', '')
      .replace('{{HOUSE_LIGHT}}', 'selected')
      .replace('{{HOUSE_OTHER}}', '')
      .replace('{{STATUS_ACTIVE}}', 'selected')
      .replace('{{STATUS_COMPLETED}}', '')
      .replace('{{STATUS_DISCHARGED}}', '')
      .replace('{{INTAKE_DATE}}', '')
      .replace('{{DAY_28}}', '')
      .replace('{{DAY_45}}', '')
      .replace('{{DAY_60}}', '')
      .replace('{{LOCATION}}', '')
      .replace('{{MEETING_IOP}}', '')
      .replace('{{COMMENTS}}', '')
      .replace('{{MESSAGE}}', '')
      .replace('{{DELETE_SECTION}}', '');
    
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }
  
  // Edit client form
  const editMatch = pathname.match(/^\/client\/(\d+)$/);
  if (editMatch) {
    const clientId = editMatch[1];
    
    if (method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        const params = new URLSearchParams(body);
        
        const intakeDate = params.get('intake_date') ? jsDateToExcelDate(new Date(params.get('intake_date'))) : null;
        const day28 = params.get('day_28') ? jsDateToExcelDate(new Date(params.get('day_28'))) : null;
        const day45 = params.get('day_45') ? jsDateToExcelDate(new Date(params.get('day_45'))) : null;
        const day60 = params.get('day_60') ? jsDateToExcelDate(new Date(params.get('day_60'))) : null;
        
        db.run(`UPDATE clients SET 
          name = ?, house = ?, status = ?, intake_date = ?, day_28 = ?, day_45 = ?, day_60 = ?,
          location = ?, meeting_iop = ?, comments = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`,
          [
            params.get('name'),
            params.get('house'),
            params.get('status'),
            intakeDate,
            day28,
            day45,
            day60,
            params.get('location'),
            params.get('meeting_iop'),
            params.get('comments'),
            clientId
          ],
          (err) => {
            if (err) {
              res.writeHead(500);
              res.end('Error updating client');
              return;
            }
            res.writeHead(302, { Location: '/' });
            res.end();
          }
        );
      });
      return;
    }
    
    // Show edit form
    db.get('SELECT * FROM clients WHERE id = ?', [clientId], (err, client) => {
      if (err || !client) {
        res.writeHead(404);
        res.end('Client not found');
        return;
      }
      
      const intakeDate = client.intake_date ? formatDate(excelDateToJSDate(client.intake_date)) : '';
      const day28 = client.day_28 ? formatDate(excelDateToJSDate(client.day_28)) : '';
      const day45 = client.day_45 ? formatDate(excelDateToJSDate(client.day_45)) : '';
      const day60 = client.day_60 ? formatDate(excelDateToJSDate(client.day_60)) : '';
      
      const deleteSection = `
        <div class="danger-zone">
          <h3>Danger Zone</h3>
          <p>Permanently delete this client and all associated data.</p>
          <form method="POST" action="/client/${clientId}/delete" style="margin-top: 15px;">
            <button type="submit" class="btn btn-danger" onclick="return confirm('Are you sure you want to delete this client? This cannot be undone.')">Delete Client</button>
          </form>
        </div>
      `;
      
      let html = editClientPage
        .replace(/{{TITLE}}/g, 'Edit Client')
        .replace('{{ACTION}}', `/client/${clientId}`)
        .replace('{{NAME}}', client.name || '')
        .replace('{{HOUSE_LIGHT}}', client.house === 'Light St' ? 'selected' : '')
        .replace('{{HOUSE_OTHER}}', client.house !== 'Light St' ? 'selected' : '')
        .replace('{{STATUS_ACTIVE}}', client.status === 'active' ? 'selected' : '')
        .replace('{{STATUS_COMPLETED}}', client.status === 'completed' ? 'selected' : '')
        .replace('{{STATUS_DISCHARGED}}', client.status === 'discharged' ? 'selected' : '')
        .replace('{{INTAKE_DATE}}', intakeDate)
        .replace('{{DAY_28}}', day28)
        .replace('{{DAY_45}}', day45)
        .replace('{{DAY_60}}', day60)
        .replace('{{LOCATION}}', client.location || '')
        .replace('{{MEETING_IOP}}', client.meeting_iop || '')
        .replace('{{COMMENTS}}', client.comments || '')
        .replace('{{MESSAGE}}', '<div class="success">Client loaded. Make your changes and click Save.</div>')
        .replace('{{DELETE_SECTION}}', deleteSection);
      
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    });
    return;
  }
  
  // Delete client
  const deleteMatch = pathname.match(/^\/client\/(\d+)\/delete$/);
  if (deleteMatch) {
    const clientId = deleteMatch[1];
    db.run('DELETE FROM clients WHERE id = ?', [clientId], (err) => {
      if (err) {
        res.writeHead(500);
        res.end('Error deleting client');
        return;
      }
      res.writeHead(302, { Location: '/' });
      res.end();
    });
    return;
  }
  
  res.writeHead(404);
  res.end('Not found');
});

// Initialize and start
console.log('Initializing database...');
populateDatabase();

server.listen(PORT, () => {
  console.log(`Walkway PHP Client Management running at http://localhost:${PORT}`);
  console.log('Password: Walkway25');
});

// Cleanup old sessions periodically
setInterval(() => {
  const cutoff = new Date(Date.now() - SESSION_TIMEOUT).toISOString();
  db.run('DELETE FROM sessions WHERE created_at < ?', [cutoff]);
}, 60 * 60 * 1000); // Every hour
