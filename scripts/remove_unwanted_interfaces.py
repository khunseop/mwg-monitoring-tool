#!/usr/bin/env python3
"""
Migration script to remove eth4, eth5, eth6, eth7 from monitoring configuration.
"""
import sys
import os
import json

# Add parent directory to path to import app modules
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.database.database import SessionLocal
from app.models.resource_config import ResourceConfig
from app.models.proxy import Proxy

def migrate():
    """Remove eth4, eth5, eth6, eth7 from common and per-proxy configurations."""
    db = SessionLocal()
    try:
        updated_count = 0
        
        # 1. Clean up ResourceConfig (Common Interfaces)
        configs = db.query(ResourceConfig).all()
        for cfg in configs:
            if not cfg.oids_json:
                continue
                
            try:
                oids = json.loads(cfg.oids_json)
                changed = False
                
                # Fields that might contain interface names
                if_fields = ['__interface_oids__', '__interface_thresholds__', '__interface_bandwidths__']
                unwanted = ['eth4', 'eth5', 'eth6', 'eth7']
                
                for field in if_fields:
                    if field in oids and isinstance(oids[field], dict):
                        for if_name in unwanted:
                            if if_name in oids[field]:
                                del oids[field][if_name]
                                changed = True
                
                if changed:
                    cfg.oids_json = json.dumps(oids)
                    updated_count += 1
                    print(f"✓ Removed unwanted interfaces from ResourceConfig id={cfg.id}")
            except Exception as e:
                print(f"⚠ Warning: Failed to process ResourceConfig id={cfg.id}: {e}")

        # 2. Clean up Proxy (Per-proxy OID overrides)
        proxies = db.query(Proxy).all()
        for p in proxies:
            if not p.oids_json:
                continue
                
            try:
                oids = json.loads(p.oids_json)
                changed = False
                
                if '__interface_oids__' in oids and isinstance(oids['__interface_oids__'], dict):
                    for if_name in ['eth4', 'eth5', 'eth6', 'eth7']:
                        if if_name in oids['__interface_oids__']:
                            del oids['__interface_oids__'][if_name]
                            changed = True
                
                if changed:
                    p.oids_json = json.dumps(oids)
                    updated_count += 1
                    print(f"✓ Removed unwanted interfaces from Proxy host={p.host}")
            except Exception as e:
                print(f"⚠ Warning: Failed to process Proxy host={p.host}: {e}")
        
        if updated_count > 0:
            db.commit()
            print(f"\n✓ Successfully updated {updated_count} record(s)")
        else:
            print("✓ No unwanted interfaces found in database")
            
    except Exception as e:
        print(f"✗ Error: {e}")
        db.rollback()
        raise
    finally:
        db.close()

if __name__ == "__main__":
    migrate()
