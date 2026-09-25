import csv
import sqlite3
import os
import sys

# Script directory and project root
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
CSV_FILE = os.path.join(PROJECT_ROOT, "data.csv")
DB_FILE = os.path.join(PROJECT_ROOT, "sangathan.db")

def build_database():
    if not os.path.exists(CSV_FILE):
        print(f"Error: CSV file not found at {CSV_FILE}")
        sys.exit(1)

    print(f"Building SQLite database from {CSV_FILE} -> {DB_FILE}...")
    conn = sqlite3.connect(DB_FILE)
    cur = conn.cursor()

    with open(CSV_FILE, "r", encoding="utf-8", errors="replace") as f:
        reader = csv.reader(f)
        headers = next(reader)
        clean_headers = [
            h.strip().replace(" ", "_").replace("/", "_").replace("-", "_").replace("'", "")
            for h in headers
        ]
        col_defs = ", ".join([f'"{col}" TEXT' for col in clean_headers])
        cur.execute("DROP TABLE IF EXISTS members")
        cur.execute(f"CREATE TABLE members ({col_defs})")
        placeholders = ", ".join(["?"] * len(clean_headers))

        rows = []
        count = 0
        for row in reader:
            if len(row) < len(clean_headers):
                row.extend([""] * (len(clean_headers) - len(row)))
            elif len(row) > len(clean_headers):
                row = row[:len(clean_headers)]
            rows.append(row)
            count += 1
            if len(rows) >= 5000:
                cur.executemany(f"INSERT INTO members VALUES ({placeholders})", rows)
                rows = []

        if rows:
            cur.executemany(f"INSERT INTO members VALUES ({placeholders})", rows)

    # Add useful indices for lightning-fast queries via SQLite MCP
    cur.execute("CREATE INDEX IF NOT EXISTS idx_district ON members(District)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_block ON members(Block)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_panchayat ON members(Panchayat)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_name ON members(Name)")

    conn.commit()
    conn.close()
    print(f"Successfully imported {count} records into {DB_FILE} with search indices.")

if __name__ == "__main__":
    build_database()
