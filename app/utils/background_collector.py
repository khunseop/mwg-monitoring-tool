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
        """주기적 수집 실행"""
        try:
            while True:
                # 수집 시작 알림
                await self._broadcast_status(task_id, "collecting")
                
                # 수집 실행
                try:
                    result = await self._collect_once(proxy_ids, community, oids)
                    await self._broadcast_status(
                        task_id,
                        "completed",
                        {
                            "requested": result["requested"],
                            "succeeded": result["succeeded"],
                            "failed": result["failed"],
                            "errors": result.get("errors", {})
                        }
                    )
                except Exception as e:
                    logger.error(f"[BackgroundCollector] Collection error: {e}", exc_info=True)
                    await self._broadcast_status(task_id, "error", {"error": str(e)})
                
                # 다음 주기까지 대기
                await asyncio.sleep(interval_sec)
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
            collected_models: list[ResourceUsageModel] = []
            
            # Get interface_oids from config
            interface_oids, _ = _get_interface_config_from_db(db)
            
            # 비동기 수집 실행
            tasks = [_collect_for_proxy(p, oids, community, db=db, interface_oids=interface_oids) for p in proxies]
            results = await asyncio.gather(*tasks, return_exceptions=True)
            
            for proxy, result in zip(proxies, results):
                try:
                    if isinstance(result, Exception):
                        errors[proxy.id] = str(result)
                        continue
                    proxy_id, metrics, err = result
                    if err:
                        errors[proxy_id] = err
                        continue
                    
                    import json as json_lib
                    interface_mbps_data = metrics.get("interface_mbps")
                    interface_mbps_json = json_lib.dumps(interface_mbps_data) if interface_mbps_data else None
                    
                    model = ResourceUsageModel(
                        proxy_id=proxy_id,
                        cpu=metrics.get("cpu"),
                        mem=metrics.get("mem"),
                        cc=metrics.get("cc"),
                        cs=metrics.get("cs"),
                        http=metrics.get("http"),
                        https=metrics.get("https"),
                        ftp=metrics.get("ftp"),
                        interface_mbps=interface_mbps_json,
                        community=community,
                        oids_raw=json_lib.dumps(oids),
                        collected_at=now_kst(),
                    )
                    db.add(model)
                    collected_models.append(model)
                except Exception as e:
                    errors[proxy.id] = str(e)
            
            db.commit()
            for model in collected_models:
                db.refresh(model)
            
            # 30일 보관 정책 적용
            _enforce_resource_usage_retention(db, days=30)
            
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


# 전역 인스턴스
background_collector = BackgroundCollector()
