#!/usr/bin/env python3
"""
Migration script to add _raw_line_ column to traffic_logs table.
"""
import sys
import os

# Add parent directory to path to import app modules
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.database.database import engine, SessionLocal
from sqlalchemy import text, inspect
from sqlalchemy.exc import OperationalError

def migrate():
    """Add _raw_line_ column to traffic_logs table if it doesn't exist."""
    db = SessionLocal()
    try:
        # Check if column already exists
        inspector = inspect(engine)
        columns = [col['name'] for col in inspector.get_columns('traffic_logs')]
        
        if '_raw_line_' in columns:
            print("✓ Column '_raw_line_' already exists in traffic_logs table")
            return
        
        # Add the column
        print("Adding '_raw_line_' column to traffic_logs table...")
        with engine.connect() as conn:
            # Using 8192 as defined in the model
            conn.execute(text("ALTER TABLE traffic_logs ADD COLUMN _raw_line_ VARCHAR(8192)"))
            conn.commit()
        
        print("✓ Successfully added '_raw_line_' column to traffic_logs table")
        
    except OperationalError as e:
        print(f"✗ Error: {e}")
        db.rollback()
        raise
    except Exception as e:
        print(f"✗ Unexpected error: {e}")
        db.rollback()
        raise
    finally:
        db.close()

if __name__ == "__main__":
    migrate()
