from fastapi import FastAPI
from app.database.database import engine
from app.models import proxy
from app.api import proxies

proxy.Base.metadata.create_all(bind=engine)

app = FastAPI(
    title="Proxy Management API",
    description="API for managing proxy servers",
    version="1.0.0"
)

app.include_router(proxies.router, prefix="/api", tags=["proxies"])
