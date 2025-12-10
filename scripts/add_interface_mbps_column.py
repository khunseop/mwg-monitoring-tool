#!/usr/bin/env python3
"""
Migration script to add interface_mbps column to resource_usage table.
Run this script once to update the database schema.
"""
import sys
import os

# Add parent directory to path to import app modules
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.database.database import engine, SessionLocal
from sqlalchemy import text, inspect
from sqlalchemy.exc import OperationalError

def migrate():
    """Add interface_mbps column to resource_usage table if it doesn't exist."""
    db = SessionLocal()
    try:
        # Check if column already exists
        inspector = inspect(engine)
        columns = [col['name'] for col in inspector.get_columns('resource_usage')]
        
        if 'interface_mbps' in columns:
            print("✓ Column 'interface_mbps' already exists in resource_usage table")
            return
        
        # Add the column
        print("Adding 'interface_mbps' column to resource_usage table...")
        with engine.connect() as conn:
            conn.execute(text("ALTER TABLE resource_usage ADD COLUMN interface_mbps TEXT"))
            conn.commit()
        
        print("✓ Successfully added 'interface_mbps' column to resource_usage table")
        
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



