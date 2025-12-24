"""
로깅 설정 유틸리티 모듈

애플리케이션 전역 로깅 설정을 관리합니다.
환경변수를 통해 로그 레벨과 출력 위치를 제어할 수 있습니다.
"""
import os
import logging
import sys
from pathlib import Path
from logging.handlers import RotatingFileHandler
from datetime import datetime


def setup_logging():
    """
    애플리케이션 로깅을 설정합니다.
    
    환경변수:
        LOG_LEVEL: 로그 레벨 (DEBUG, INFO, WARNING, ERROR, CRITICAL). 기본값: INFO
        LOG_DIR: 로그 파일 저장 디렉토리. 기본값: ./logs
        LOG_TO_CONSOLE: 콘솔 출력 여부 (true/false). 기본값: true
        LOG_TO_FILE: 파일 출력 여부 (true/false). 기본값: true
        LOG_MAX_BYTES: 로그 파일 최대 크기 (바이트). 기본값: 10485760 (10MB)
        LOG_BACKUP_COUNT: 로그 파일 백업 개수. 기본값: 5
    """
    # 환경변수에서 설정 읽기
    log_level_str = os.getenv("LOG_LEVEL", "INFO").upper()
    log_dir = os.getenv("LOG_DIR", "./logs")
    log_to_console = os.getenv("LOG_TO_CONSOLE", "true").lower() in {"1", "true", "yes"}
    log_to_file = os.getenv("LOG_TO_FILE", "true").lower() in {"1", "true", "yes"}
    log_max_bytes = int(os.getenv("LOG_MAX_BYTES", "10485760"))  # 10MB
    log_backup_count = int(os.getenv("LOG_BACKUP_COUNT", "5"))
    
    # 로그 레벨 변환
    log_level = getattr(logging, log_level_str, logging.INFO)
    
    # 루트 로거 설정
    root_logger = logging.getLogger()
    root_logger.setLevel(log_level)
    
    # 기존 핸들러 제거 (중복 방지)
    root_logger.handlers.clear()
    
    # 로그 포맷 설정
    log_format = logging.Formatter(
        '%(asctime)s - %(name)s - %(levelname)s - %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S'
    )
    
    # 콘솔 핸들러 추가
    if log_to_console:
        try:
            # PyInstaller 빌드 환경에서 sys.stdout이 None이거나 isatty()를 지원하지 않을 수 있음
            if sys.stdout is not None and hasattr(sys.stdout, 'isatty'):
                try:
                    # isatty() 호출 시 에러가 발생할 수 있으므로 try-except로 감쌈
                    sys.stdout.isatty()
                except (AttributeError, OSError):
                    # isatty() 실패 시 파일 핸들러로 대체
                    log_to_console = False
                    if not log_to_file:
                        # 파일 핸들러가 없으면 강제로 생성
                        log_to_file = True
            
            if log_to_console and sys.stdout is not None:
                console_handler = logging.StreamHandler(sys.stdout)
                console_handler.setLevel(log_level)
                console_handler.setFormatter(log_format)
                root_logger.addHandler(console_handler)
        except Exception as e:
            # 콘솔 핸들러 생성 실패 시 무시 (파일 핸들러만 사용)
            root_logger.warning(f"콘솔 핸들러 생성 실패: {e}. 파일 핸들러만 사용합니다.")
    
    # 파일 핸들러 추가
    if log_to_file:
        try:
            # 로그 디렉토리 생성
            log_path = Path(log_dir)
            log_path.mkdir(parents=True, exist_ok=True)
            
            # 로그 파일 경로
            log_file = log_path / "pmt.log"
            
            # 회전 파일 핸들러 생성
            file_handler = RotatingFileHandler(
                log_file,
                maxBytes=log_max_bytes,
                backupCount=log_backup_count,
                encoding='utf-8'
            )
            file_handler.setLevel(log_level)
            file_handler.setFormatter(log_format)
            root_logger.addHandler(file_handler)
            
            root_logger.info(f"로깅이 초기화되었습니다. 로그 파일: {log_file}")
        except Exception as e:
            # 파일 핸들러 생성 실패 시 콘솔에만 출력
            root_logger.warning(f"로그 파일 핸들러 생성 실패: {e}. 콘솔 출력만 사용합니다.")
    
    # 외부 라이브러리 로그 레벨 조정
    logging.getLogger("uvicorn").setLevel(logging.WARNING)
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    logging.getLogger("fastapi").setLevel(logging.WARNING)
    logging.getLogger("sqlalchemy.engine").setLevel(logging.WARNING)
    
    return root_logger
