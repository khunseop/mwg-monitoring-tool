#!/usr/bin/env python3
"""
Migration script to add missing columns to resource_usage table.
This script checks for all columns defined in the ResourceUsage model and adds them if they are missing from the database.
Specifically adds 'disk', 'cc', 'cs', 'http', 'https', 'ftp' if they don't exist.
"""
import sys
import os

# Add parent directory to path to import app modules
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.database.database import engine, SessionLocal
from sqlalchemy import text, inspect
from sqlalchemy.exc import OperationalError
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def migrate():
    """Add missing columns to resource_usage table."""
    db = SessionLocal()
    try:
        # Check if column already exists
        inspector = inspect(engine)
        
        # 1. Check if 'resource_usage' table exists
        if 'resource_usage' not in inspector.get_table_names():
            logger.error("'resource_usage' table not found. Please run the application first to initialize the database.")
            return

        columns = [col['name'] for col in inspector.get_columns('resource_usage')]
        
        # List of columns to check and their types
        # According to app/models/resource_usage.py
        target_columns = [
            ('cc', 'FLOAT'),
            ('cs', 'FLOAT'),
            ('http', 'FLOAT'),
            ('https', 'FLOAT'),
            ('ftp', 'FLOAT'),
            ('disk', 'FLOAT'),
            ('oids_raw', 'TEXT'),
            ('community', 'VARCHAR(255)')
        ]
        
        # Determine database type for appropriate SQL syntax
        db_type = engine.url.drivername
        
        added_columns = []
        
        with engine.connect() as conn:
            for col_name, col_type in target_columns:
                if col_name not in columns:
                    logger.info(f"Adding '{col_name}' column to resource_usage table...")
                    
                    actual_type = col_type
                    if "postgresql" in db_type and col_type == 'FLOAT':
                        actual_type = 'DOUBLE PRECISION'
                    
                    try:
                        conn.execute(text(f"ALTER TABLE resource_usage ADD COLUMN {col_name} {actual_type}"))
                        added_columns.append(col_name)
                    except Exception as e:
                        logger.error(f"Failed to add column {col_name}: {e}")
            
            if added_columns:
                conn.commit()
                logger.info(f"✓ Successfully added columns: {', '.join(added_columns)}")
            else:
                logger.info("✓ No missing columns found in resource_usage table")
        
    except OperationalError as e:
        logger.error(f"✗ Error: {e}")
        db.rollback()
        raise
    except Exception as e:
        logger.error(f"✗ Unexpected error: {e}")
        db.rollback()
        raise
    finally:
        db.close()

if __name__ == "__main__":
    logger.info("Starting resource_usage columns migration...")
    try:
        migrate()
        logger.info("Migration completed successfully")
    except Exception as e:
        logger.error(f"Migration failed: {e}")
        sys.exit(1)
