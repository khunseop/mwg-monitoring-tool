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
        # Check if blocked column exists
        cursor.execute("PRAGMA table_info(resource_usage)")
        columns = [row[1] for row in cursor.fetchall()]
        
        if 'blocked' not in columns:
            print("Adding column 'blocked' to 'resource_usage' table...")
            cursor.execute("ALTER TABLE resource_usage ADD COLUMN blocked FLOAT")
            conn.commit()
            print("Migration successful.")
        else:
            print("Column 'blocked' already exists. No migration needed.")

    except Exception as e:
        print(f"Migration failed: {e}")
    finally:
        conn.close()

if __name__ == "__main__":
    migrate()
