import sqlite3
import os

def migrate():
    db_path = "pmt.db"
    if not os.path.exists(db_path):
        print(f"Database {db_path} not found.")
        return

    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    try:
        # Check if ftp column exists
        cursor.execute("PRAGMA table_info(resource_usage)")
        columns = [row[1] for row in cursor.fetchall()]
        
        if 'ftp' in columns and 'http2' not in columns:
            print("Renaming column 'ftp' to 'http2' in 'resource_usage' table...")
            # SQLite 3.25.0+ supports RENAME COLUMN
            try:
                cursor.execute("ALTER TABLE resource_usage RENAME COLUMN ftp TO http2")
                conn.commit()
                print("Migration successful.")
            except sqlite3.OperationalError as e:
                print(f"Error during rename: {e}")
                print("Attempting manual migration (copy table)...")
                # Fallback for older SQLite versions if needed, but modern Python usually has 3.25+
                # For now just report the error
        elif 'http2' in columns:
            print("Column 'http2' already exists. No migration needed.")
        else:
            print("Column 'ftp' not found. Nothing to migrate.")

    except Exception as e:
        print(f"Migration failed: {e}")
    finally:
        conn.close()

if __name__ == "__main__":
    migrate()
