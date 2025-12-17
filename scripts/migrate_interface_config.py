#!/usr/bin/env python3
"""
Migration script to clean up legacy __selected_interfaces__ key from resource_config.
This script removes the deprecated __selected_interfaces__ key from oids_json field.

Run this script once to clean up existing data.
"""
import sys
import os
import json

# Add parent directory to path to import app modules
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.database.database import SessionLocal
from app.models.resource_config import ResourceConfig

def migrate():
    """Remove legacy __selected_interfaces__ key from resource_config.oids_json"""
    db = SessionLocal()
    try:
        configs = db.query(ResourceConfig).all()
        updated_count = 0
        
        for cfg in configs:
            if not cfg.oids_json:
                continue
                
            try:
                oids = json.loads(cfg.oids_json or '{}')
                if not isinstance(oids, dict):
                    continue
                
                # Check if __selected_interfaces__ exists
                if '__selected_interfaces__' in oids:
                    # Remove the legacy key
                    del oids['__selected_interfaces__']
                    cfg.oids_json = json.dumps(oids)
                    updated_count += 1
                    print(f"✓ Removed __selected_interfaces__ from config id={cfg.id}")
            except (json.JSONDecodeError, Exception) as e:
                print(f"⚠ Warning: Failed to process config id={cfg.id}: {e}")
                continue
        
        if updated_count > 0:
            db.commit()
            print(f"\n✓ Successfully migrated {updated_count} config record(s)")
        else:
            print("✓ No migration needed - no legacy __selected_interfaces__ keys found")
            
    except Exception as e:
        print(f"✗ Error: {e}")
        db.rollback()
        raise
    finally:
        db.close()

if __name__ == "__main__":
    migrate()
