"""
백그라운드 자원사용률 수집 작업 관리자
웹소켓을 통해 클라이언트에 수집 상태를 전송합니다.
"""
import asyncio
import json
import logging
from typing import Dict, Set, Optional, Callable, Any
from datetime import datetime
from sqlalchemy.orm import Session
from app.database.database import SessionLocal
from app.models.proxy import Proxy
from app.models.resource_usage import ResourceUsage as ResourceUsageModel
from app.utils.time import now_kst

logger = logging.getLogger(__name__)


class BackgroundCollector:
    """백그라운드 수집 작업 관리자"""
    
    def __init__(self):
        self._running_tasks: Dict[str, asyncio.Task] = {}
        self._websocket_clients: Set[Any] = set()
        self._collection_status: Dict[str, dict] = {}  # {task_id: {status, started_at, ...}}
        self._lock = asyncio.Lock()
        self._retention_task: Optional[asyncio.Task] = None
        self._retention_interval_sec = 3600  # 1시간마다 실행
    
    async def register_websocket(self, websocket):
        """웹소켓 클라이언트 등록"""
        async with self._lock:
            self._websocket_clients.add(websocket)
            logger.info(f"[BackgroundCollector] WebSocket client registered. Total: {len(self._websocket_clients)}")
    
    async def unregister_websocket(self, websocket):
        """웹소켓 클라이언트 해제"""
        async with self._lock:
            self._websocket_clients.discard(websocket)
            logger.info(f"[BackgroundCollector] WebSocket client unregistered. Total: {len(self._websocket_clients)}")
    
    async def _broadcast_status(self, task_id: str, status: str, data: Optional[dict] = None):
        """모든 웹소켓 클라이언트에 상태 브로드캐스트"""
        message = {
            "type": "collection_status",
            "task_id": task_id,
            "status": status,
            "timestamp": datetime.now().isoformat(),
            "data": data or {}
        }
        
        async with self._lock:
            disconnected = set()
            for ws in self._websocket_clients:
                try:
                    await ws.send_json(message)
                except Exception as e:
                    logger.warning(f"[BackgroundCollector] Failed to send to WebSocket: {e}")
                    disconnected.add(ws)
            
            # 연결이 끊어진 클라이언트 제거
            for ws in disconnected:
                self._websocket_clients.discard(ws)
    
    async def start_collection(
        self,
        task_id: str,
        proxy_ids: list[int],
        community: str,
        oids: dict,
        interval_sec: int
    ):
        """백그라운드 수집 작업 시작"""
        async with self._lock:
            if task_id in self._running_tasks:
                logger.warning(f"[BackgroundCollector] Task {task_id} already running")
                return
            
            # 주기적 수집 작업 생성
            task = asyncio.create_task(
                self._periodic_collect(task_id, proxy_ids, community, oids, interval_sec)
            )
            self._running_tasks[task_id] = task
            self._collection_status[task_id] = {
                "status": "running",
                "started_at": datetime.now().isoformat(),
                "proxy_ids": proxy_ids,
                "interval_sec": interval_sec
            }
        
        await self._broadcast_status(task_id, "started", {"proxy_ids": proxy_ids, "interval_sec": interval_sec})
        logger.info(f"[BackgroundCollector] Started collection task {task_id} for proxies {proxy_ids}")
    
    async def stop_collection(self, task_id: str):
        """수집 작업 중지"""
        async with self._lock:
            if task_id not in self._running_tasks:
                return
            
            task = self._running_tasks.pop(task_id)
            task.cancel()
            self._collection_status.pop(task_id, None)
        
        await self._broadcast_status(task_id, "stopped")
        logger.info(f"[BackgroundCollector] Stopped collection task {task_id}")
        
        try:
            await task
        except asyncio.CancelledError:
            pass
    
    async def _periodic_collect(
        self,
        task_id: str,
        proxy_ids: list[int],
        community: str,
        oids: dict,
        interval_sec: int
    ):
        """주기적 수집 실행 (정확한 주기 유지)"""
        import time
        try:
            # 첫 수집은 즉시 실행
            next_collect_time = time.time()
            
            while True:
                # 정확한 주기 유지를 위해 다음 수집 시간 계산
                current_time = time.time()
                sleep_time = next_collect_time - current_time
                
                # 수집 시간이 주기보다 길어지면 즉시 다음 수집 시작
                if sleep_time < 0:
                    logger.warning(f"[BackgroundCollector] Collection took longer than interval ({interval_sec}s), starting next immediately")
                    sleep_time = 0
                
                # 대기 (첫 수집이 아닌 경우에만)
                if sleep_time > 0:
                    await asyncio.sleep(sleep_time)
                
                # 다음 수집 시간 설정 (현재 시간 기준으로 정확히 interval_sec 후)
                next_collect_time = time.time() + interval_sec
                
                # 수집 시작 알림
                collect_start_time = time.time()
                await self._broadcast_status(task_id, "collecting")
                
                # 수집 실행
                try:
                    result = await self._collect_once(proxy_ids, community, oids)
                    collect_duration = time.time() - collect_start_time
                    
                    logger.info(f"[BackgroundCollector] Collection completed for task {task_id}: "
                              f"succeeded={result['succeeded']}, failed={result['failed']}, "
                              f"duration={collect_duration:.2f}s, next_in={interval_sec}s")
                    
                    await self._broadcast_status(
                        task_id,
                        "completed",
                        {
                            "requested": result["requested"],
                            "succeeded": result["succeeded"],
                            "failed": result["failed"],
                            "errors": result.get("errors", {}),
                            "duration_sec": round(collect_duration, 2),
                            "next_collect_at": datetime.fromtimestamp(next_collect_time).isoformat()
                        }
                    )
                except Exception as e:
                    collect_duration = time.time() - collect_start_time
                    logger.error(f"[BackgroundCollector] Collection error for task {task_id} (duration={collect_duration:.2f}s): {e}", exc_info=True)
                    await self._broadcast_status(task_id, "error", {
                        "error": str(e),
                        "duration_sec": round(collect_duration, 2)
                    })
        except asyncio.CancelledError:
            logger.info(f"[BackgroundCollector] Collection task {task_id} cancelled")
            raise
    
    async def _collect_once(
        self,
        proxy_ids: list[int],
        community: str,
        oids: dict
    ) -> dict:
        """단일 수집 실행 (백그라운드에서 실행)"""
        # 순환 import 방지를 위해 여기서 import
        from app.api.resource_usage import _collect_for_proxy, _enforce_resource_usage_retention, _get_interface_config_from_db
        
        db = SessionLocal()
        try:
            query = db.query(Proxy).filter(Proxy.is_active == True).filter(Proxy.id.in_(proxy_ids))
            proxies: list[Proxy] = query.all()
            
            if not proxies:
                return {"requested": 0, "succeeded": 0, "failed": 0, "errors": {}}
            
            errors: Dict[int, str] = {}
            collected_data: list[dict] = []
            
            # Get interface_oids from config
            interface_oids, _, _ = _get_interface_config_from_db(db)
            
            # 비동기 수집 실행
            tasks = [_collect_for_proxy(p, oids, community, db=db, interface_oids=interface_oids) for p in proxies]
            results = await asyncio.gather(*tasks, return_exceptions=True)
            
            import json as json_lib
            collected_at_ts = now_kst()
            
            for proxy, result in zip(proxies, results):
                try:
                    if isinstance(result, Exception):
                        errors[proxy.id] = str(result)
                        continue
                    proxy_id, metrics, err = result
                    if err:
                        errors[proxy_id] = err
                        continue
                    
                    interface_mbps_data = metrics.get("interface_mbps")
                    interface_mbps_json = json_lib.dumps(interface_mbps_data) if interface_mbps_data else None
                    
                    # 인터페이스 데이터 수집 확인 로그
                    if interface_mbps_data:
                        if_count = len(interface_mbps_data) if isinstance(interface_mbps_data, dict) else 0
                        logger.debug(f"[BackgroundCollector] Interface data collected for proxy_id={proxy_id}: {if_count} interfaces")
                    else:
                        logger.debug(f"[BackgroundCollector] No interface data for proxy_id={proxy_id}")
                    
                    # Prepare data for bulk insert
                    collected_data.append({
                        "proxy_id": proxy_id,
                        "cpu": metrics.get("cpu"),
                        "mem": metrics.get("mem"),
                        "cc": metrics.get("cc"),
                        "cs": metrics.get("cs"),
                        "http": metrics.get("http"),
                        "https": metrics.get("https"),
                        "ftp": metrics.get("ftp"),
                        "interface_mbps": interface_mbps_json,
                        "community": community,
                        "oids_raw": json_lib.dumps(oids),
                        "collected_at": collected_at_ts,
                        "created_at": collected_at_ts,
                        "updated_at": collected_at_ts,
                    })
                    
                    # 저장 전 데이터 확인 로그
                    logger.debug(f"[BackgroundCollector] Preparing data for proxy_id={proxy_id}: "
                               f"cpu={metrics.get('cpu')}, mem={metrics.get('mem')}, "
                               f"http={metrics.get('http')}, https={metrics.get('https')}, ftp={metrics.get('ftp')}, "
                               f"interface_mbps={'present' if interface_mbps_json else 'none'}")
                except Exception as e:
                    errors[proxy.id] = str(e)
            
            # Bulk insert for better performance
            collected_models: list[ResourceUsageModel] = []
            if collected_data:
                try:
                    db.bulk_insert_mappings(ResourceUsageModel, collected_data)
                    db.commit()
                    # Refresh models to get IDs (for response)
                    # Note: bulk_insert_mappings doesn't return IDs, so we query them back
                    for data in collected_data:
                        model = db.query(ResourceUsageModel).filter(
                            ResourceUsageModel.proxy_id == data["proxy_id"],
                            ResourceUsageModel.collected_at == data["collected_at"]
                        ).order_by(ResourceUsageModel.id.desc()).first()
                        if model:
                            collected_models.append(model)
                    logger.info(f"[BackgroundCollector] Bulk inserted {len(collected_data)} records to database "
                             f"(requested={len(proxies)}, failed={len(errors)})")
                except Exception as e:
                    logger.error(f"[BackgroundCollector] Bulk insert failed, falling back to individual inserts: {e}")
                    db.rollback()
                    # Fallback to individual inserts
                    for data in collected_data:
                        try:
                            model = ResourceUsageModel(**data)
                            db.add(model)
                            collected_models.append(model)
                        except Exception as e2:
                            logger.error(f"[BackgroundCollector] Failed to insert record: {e2}")
                    db.commit()
                    for model in collected_models:
                        db.refresh(model)
            
            # 저장 완료 로그
            logger.info(f"[BackgroundCollector] Saved {len(collected_models)} records to database "
                       f"(requested={len(proxies)}, failed={len(errors)})")
            
            # 보존 정책은 별도 백그라운드 작업에서 처리 (매 수집마다 실행하지 않음)
            
            return {
                "requested": len(proxies),
                "succeeded": len(collected_models),
                "failed": len(errors),
                "errors": errors
            }
        finally:
            db.close()
    
    def get_status(self, task_id: Optional[str] = None) -> dict:
        """수집 상태 조회"""
        if task_id:
            return self._collection_status.get(task_id, {})
        return {
            "tasks": dict(self._collection_status),
            "active_count": len(self._running_tasks)
        }
    
    def is_running(self, task_id: str) -> bool:
        """작업 실행 중 여부 확인"""
        return task_id in self._running_tasks
    
    async def start_retention_policy(self, interval_sec: int = 3600):
        """보존 정책 백그라운드 작업 시작 (기본 1시간마다 실행)"""
        if self._retention_task is not None and not self._retention_task.done():
            logger.info("[BackgroundCollector] Retention policy task already running")
            return
        
        self._retention_interval_sec = interval_sec
        self._retention_task = asyncio.create_task(self._periodic_retention())
        logger.info(f"[BackgroundCollector] Started retention policy task (interval={interval_sec}s)")
    
    async def stop_retention_policy(self):
        """보존 정책 백그라운드 작업 중지"""
        if self._retention_task is not None:
            self._retention_task.cancel()
            try:
                await self._retention_task
            except asyncio.CancelledError:
                pass
            self._retention_task = None
            logger.info("[BackgroundCollector] Stopped retention policy task")
    
    async def _periodic_retention(self):
        """주기적으로 보존 정책 실행"""
        import time
        from app.api.resource_usage import _enforce_resource_usage_retention
        
        try:
            while True:
                await asyncio.sleep(self._retention_interval_sec)
                
                db = SessionLocal()
                try:
                    logger.info("[BackgroundCollector] Running retention policy (90 days)")
                    _enforce_resource_usage_retention(db, days=90)
                    logger.info("[BackgroundCollector] Retention policy completed")
                except Exception as e:
                    logger.error(f"[BackgroundCollector] Retention policy error: {e}", exc_info=True)
                finally:
                    db.close()
        except asyncio.CancelledError:
            logger.info("[BackgroundCollector] Retention policy task cancelled")
            raise


# 전역 인스턴스
background_collector = BackgroundCollector()
