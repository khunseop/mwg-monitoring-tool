"""
로깅 설정 유틸리티 모듈

환경변수:
    LOG_LEVEL: 로그 레벨 (DEBUG, INFO, WARNING, ERROR, CRITICAL). 기본값: INFO
    LOG_DIR: 로그 파일 저장 디렉토리. 기본값: ./logs
    LOG_TO_CONSOLE: 콘솔 출력 여부 (true/false). 기본값: true
    LOG_TO_FILE: 파일 출력 여부 (true/false). 기본값: true
    LOG_MAX_BYTES: 로그 파일 최대 크기 (바이트). 기본값: 10485760 (10MB)
    LOG_BACKUP_COUNT: 로그 파일 백업 개수. 기본값: 5
    LOG_JSON: JSON 포맷 출력 여부 (true/false). 기본값: false
"""
import os
import logging
import sys
from pathlib import Path
from logging.handlers import RotatingFileHandler


def _make_formatter(use_json: bool) -> logging.Formatter:
    if use_json:
        try:
            from pythonjsonlogger import jsonlogger
            return jsonlogger.JsonFormatter(
                fmt="%(asctime)s %(name)s %(levelname)s %(message)s",
                datefmt="%Y-%m-%dT%H:%M:%S",
            )
        except ImportError:
            pass
    return logging.Formatter(
        "%(asctime)s - %(name)s - %(levelname)s - %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )


def setup_logging():
    log_level_str = os.getenv("LOG_LEVEL", "INFO").upper()
    log_dir = os.getenv("LOG_DIR", "./logs")
    log_to_console = os.getenv("LOG_TO_CONSOLE", "true").lower() in {"1", "true", "yes"}
    log_to_file = os.getenv("LOG_TO_FILE", "true").lower() in {"1", "true", "yes"}
    log_max_bytes = int(os.getenv("LOG_MAX_BYTES", "10485760"))
    log_backup_count = int(os.getenv("LOG_BACKUP_COUNT", "5"))
    use_json = os.getenv("LOG_JSON", "false").lower() in {"1", "true", "yes"}

    log_level = getattr(logging, log_level_str, logging.INFO)
    formatter = _make_formatter(use_json)

    root_logger = logging.getLogger()
    root_logger.setLevel(log_level)
    root_logger.handlers.clear()

    if log_to_console:
        try:
            if sys.stdout is not None and hasattr(sys.stdout, "isatty"):
                try:
                    sys.stdout.isatty()
                except (AttributeError, OSError):
                    log_to_console = False
                    if not log_to_file:
                        log_to_file = True

            if log_to_console and sys.stdout is not None:
                console_handler = logging.StreamHandler(sys.stdout)
                console_handler.setLevel(log_level)
                console_handler.setFormatter(formatter)
                root_logger.addHandler(console_handler)
        except Exception as e:
            root_logger.warning("콘솔 핸들러 생성 실패: %s", e)

    if log_to_file:
        try:
            log_path = Path(log_dir)
            log_path.mkdir(parents=True, exist_ok=True)
            log_file = log_path / "pmt.log"
            file_handler = RotatingFileHandler(
                log_file,
                maxBytes=log_max_bytes,
                backupCount=log_backup_count,
                encoding="utf-8",
            )
            file_handler.setLevel(log_level)
            file_handler.setFormatter(formatter)
            root_logger.addHandler(file_handler)
            root_logger.info("로깅이 초기화되었습니다. 로그 파일: %s", log_file)
        except Exception as e:
            root_logger.warning("로그 파일 핸들러 생성 실패: %s", e)

    logging.getLogger("uvicorn").setLevel(logging.WARNING)
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    logging.getLogger("fastapi").setLevel(logging.WARNING)
    logging.getLogger("sqlalchemy.engine").setLevel(logging.WARNING)

    return root_logger
