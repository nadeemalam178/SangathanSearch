# Sangathan Search Website

A contact directory and analytics dashboard for the Jan Suraaj organization.

## 🚀 How to Open & Run

### Option 1: 1-Click Launcher (Recommended for Windows)
Double-click **`Start_Website.bat`**.
This starts a local web server and automatically opens the website at `http://localhost:8080/index.html`.

---

### Option 2: Direct Opening (`file:///`)
1. Double-click `index.html` to open it in Chrome, Edge, or Firefox.
2. If prompted by the browser security policy, click **"📂 Select data.csv File"** and choose the `data.csv` file located in this folder (or drag and drop `data.csv` onto the screen).
3. The data will be indexed and cached in your browser's IndexedDB so it opens instantly on subsequent visits.

---

### Option 3: Terminal / Command Line
If you prefer running from the command line:
```bash
python -m http.server 8080
```
Then open `http://localhost:8080/index.html` in your browser.

---

## 🤖 AI & Model Context Protocol (MCP) Tooling

This repository includes configuration and tooling for AI agents (Antigravity, Claude, Cursor) via MCP:

- **SQLite Database**: Run `npm run build:db` (or `python scripts/build_sqlite.py`) to convert `data.csv` into an indexed `sangathan.db` for instant SQL analytics.
- **MCP Servers (`.agents/mcp_config.json`)**:
  - `chrome-devtools-mcp`: Browser testing, DOM snapshots, console monitoring.
  - `sqlite`: Direct SQL queries on 215,000+ members database.
  - `filesystem`: Project and downloads file navigation.
  - `git`: Git repository operations and status.
  - `sequential-thinking`: Complex multi-step reasoning.
  - `memory`: Knowledge graph context persistence.
  - `context7`: Up-to-date documentation lookup.
  - `github`: GitHub integration.

