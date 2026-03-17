#!/usr/bin/env python3
"""
Migration script to add default_grid_page_size column to session_browser_config table.
"""
import sys
import os

# Add parent directory to path to import app modules
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.database.database import engine, SessionLocal
from sqlalchemy import text, inspect
from sqlalchemy.exc import OperationalError

def migrate():
    """Add default_grid_page_size column to session_browser_config table if it doesn't exist."""
    db = SessionLocal()
    try:
        # Check if table exists
        inspector = inspect(engine)
        if 'session_browser_config' not in inspector.get_table_names():
            print("session_browser_config table not found. Skipping.")
            return

        columns = [col['name'] for col in inspector.get_columns('session_browser_config')]
        
        if 'default_grid_page_size' in columns:
            print("✓ Column 'default_grid_page_size' already exists in session_browser_config table")
            return
        
        # Add the column
        print("Adding 'default_grid_page_size' column to session_browser_config table...")
        with engine.connect() as conn:
            conn.execute(text("ALTER TABLE session_browser_config ADD COLUMN default_grid_page_size INTEGER DEFAULT 50"))
            conn.commit()
        
        print("✓ Successfully added 'default_grid_page_size' column to session_browser_config table")
        
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
