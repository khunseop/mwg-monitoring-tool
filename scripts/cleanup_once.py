#!/usr/bin/env python3
import sys

from app.database.database import SessionLocal
from app.models.traffic_log import TrafficLog
from app.models.session_record import SessionRecord


def main() -> int:
    db = SessionLocal()
    try:
        deleted_logs = db.query(TrafficLog).delete(synchronize_session=False)
        deleted_sessions = db.query(SessionRecord).delete(synchronize_session=False)
        db.commit()
        print(f"Deleted traffic_logs={deleted_logs} session_records={deleted_sessions}")
        return 0
    except Exception as e:
        try:
            db.rollback()
        except Exception:
            pass
        print(f"Error during cleanup: {e}", file=sys.stderr)
        return 1
    finally:
        try:
            db.close()
        except Exception:
            pass


if __name__ == "__main__":
    raise SystemExit(main())

