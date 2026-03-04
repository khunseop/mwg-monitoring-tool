import sys
import os
from sqlalchemy import text, inspect

# Add project root to sys.path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.database.database import engine

def migrate():
    """
    Checks if 'oids_json' column exists in 'proxies' table and adds it if missing.
    """
    print("Checking database schema...")
    inspector = inspect(engine)
    
    # 1. Check if 'proxies' table exists
    if 'proxies' not in inspector.get_table_names():
        print("Error: 'proxies' table not found. Please run the application first to initialize the database.")
        return

    # 2. Check for 'oids_json' column
    columns = [c["name"] for c in inspector.get_columns("proxies")]
    if "oids_json" not in columns:
        print("Adding 'oids_json' column to 'proxies' table...")
        try:
            with engine.connect() as conn:
                # Use standard SQL for column addition
                conn.execute(text("ALTER TABLE proxies ADD COLUMN oids_json TEXT"))
                conn.commit()
            print("Successfully added 'oids_json' column.")
        except Exception as e:
            print(f"Error during migration: {e}")
    else:
        print("'oids_json' column already exists in 'proxies' table. Skipping.")

if __name__ == "__main__":
    migrate()
