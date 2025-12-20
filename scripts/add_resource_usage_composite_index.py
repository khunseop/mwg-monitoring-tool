#!/usr/bin/env python3
"""
Add composite index on (proxy_id, collected_at) to resource_usage table for performance optimization.
This script can be run safely multiple times (idempotent).
"""
import sys
import os

# Add parent directory to path to import app modules
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.database.database import engine
from sqlalchemy import text
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def add_composite_index():
    """Add composite index on (proxy_id, collected_at) if it doesn't exist"""
    index_name = "idx_resource_usage_proxy_collected"
    
    try:
        with engine.connect() as conn:
            # Check if index already exists
            if engine.url.drivername == "sqlite":
                # SQLite: check if index exists
                result = conn.execute(text(
                    "SELECT name FROM sqlite_master WHERE type='index' AND name=:name"
                ), {"name": index_name})
                if result.fetchone():
                    logger.info(f"Index {index_name} already exists, skipping")
                    return
                
                # Create index
                logger.info(f"Creating composite index {index_name} on (proxy_id, collected_at)...")
                conn.execute(text(
                    f"CREATE INDEX IF NOT EXISTS {index_name} ON resource_usage(proxy_id, collected_at)"
                ))
                conn.commit()
                logger.info(f"Successfully created index {index_name}")
            else:
                # PostgreSQL/MySQL: check if index exists
                if engine.url.drivername.startswith("postgresql"):
                    result = conn.execute(text(
                        "SELECT indexname FROM pg_indexes WHERE indexname = :name"
                    ), {"name": index_name})
                    if result.fetchone():
                        logger.info(f"Index {index_name} already exists, skipping")
                        return
                    
                    logger.info(f"Creating composite index {index_name} on (proxy_id, collected_at)...")
                    conn.execute(text(
                        f"CREATE INDEX IF NOT EXISTS {index_name} ON resource_usage(proxy_id, collected_at)"
                    ))
                    conn.commit()
                    logger.info(f"Successfully created index {index_name}")
                elif engine.url.drivername.startswith("mysql"):
                    result = conn.execute(text(
                        "SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS "
                        "WHERE TABLE_SCHEMA = DATABASE() AND INDEX_NAME = :name"
                    ), {"name": index_name})
                    if result.fetchone():
                        logger.info(f"Index {index_name} already exists, skipping")
                        return
                    
                    logger.info(f"Creating composite index {index_name} on (proxy_id, collected_at)...")
                    conn.execute(text(
                        f"CREATE INDEX {index_name} ON resource_usage(proxy_id, collected_at)"
                    ))
                    conn.commit()
                    logger.info(f"Successfully created index {index_name}")
                else:
                    logger.warning(f"Unsupported database driver: {engine.url.drivername}")
                    return
    except Exception as e:
        logger.error(f"Error creating index: {e}", exc_info=True)
        raise


if __name__ == "__main__":
    logger.info("Starting composite index migration...")
    try:
        add_composite_index()
        logger.info("Migration completed successfully")
    except Exception as e:
        logger.error(f"Migration failed: {e}", exc_info=True)
        sys.exit(1)

