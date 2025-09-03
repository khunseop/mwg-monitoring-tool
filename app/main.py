from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from app.database.database import engine
from app.models import proxy, proxy_group
from app.models import resource_usage as resource_usage_model
from app.models import resource_config as resource_config_model
from app.models import session_record as session_record_model
from app.models import session_browser_config as session_browser_config_model
from app.api import proxies, proxy_groups
from app.api import resource_usage as resource_usage_api
from app.api import resource_config as resource_config_api
from app.api import session_browser as session_browser_api
import os
from fastapi_standalone_docs import StandaloneDocs

proxy.Base.metadata.create_all(bind=engine)
resource_usage_model.Base.metadata.create_all(bind=engine)
resource_config_model.Base.metadata.create_all(bind=engine)
session_record_model.Base.metadata.create_all(bind=engine)
session_browser_config_model.Base.metadata.create_all(bind=engine)

app = FastAPI(
    title="PPAT",
    description="Proxy Performance Analysis Tool",
    version="1.0.0"
)
StandaloneDocs(app)

# 템플릿과 정적 파일 설정
templates = Jinja2Templates(directory="app/templates")
app.mount("/static", StaticFiles(directory="app/static"), name="static")

# API 라우터
app.include_router(proxies.router, prefix="/api", tags=["proxies"])
app.include_router(proxy_groups.router, prefix="/api", tags=["proxy-groups"])
app.include_router(resource_usage_api.router, prefix="/api", tags=["resource-usage"])
app.include_router(resource_config_api.router, prefix="/api", tags=["resource-config"])
app.include_router(session_browser_api.router, prefix="/api", tags=["session-browser"])

# 페이지 라우터
@app.get("/")
async def read_settings(request: Request):
    return templates.TemplateResponse("components/settings.html", {"request": request})

@app.get("/resource")
async def read_resource(request: Request):
    return templates.TemplateResponse("components/resource_usage.html", {"request": request})
