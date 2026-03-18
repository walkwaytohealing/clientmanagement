# Walkway PHP Client Management

A web-based client management system for Walkway to Healing's Partial Hospitalization Program (PHP).

## Features

- **Client Tracking**: Track clients through their 28-60 day program
- **House Management**: Assign clients to houses (Light St, etc.)
- **Milestone Dates**: Auto-calculate 28, 45, and 60 day milestones
- **Meeting Reminders**: Track IOP meetings and important dates
- **Status Management**: Active, Completed, or Discharged statuses
- **Notes & Comments**: Keep detailed client notes

## Access

- URL: http://localhost:3456
- Password: Walkway25

## Installation

```bash
npm install
node server.js
```

Or use `start.bat` on Windows.

## Data Import

The app automatically imports client data from the Excel file on startup:
`C:\Users\think\Downloads\Copy of Transitions.xlsm.xlsx`

## Database

SQLite database stored locally at `php_clients.db` — completely separate from the Excel source file.

## Tech Stack

- Node.js
- SQLite3
- Vanilla HTML/CSS/JS
- No external frameworks
