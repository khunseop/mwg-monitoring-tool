# PyInstaller hook for uvicorn

from PyInstaller.utils.hooks import collect_data_files, copy_metadata

datas = collect_data_files('uvicorn', include_py_files=True)
datas += copy_metadata('uvicorn')

hiddenimports = [
    'uvicorn',
    'uvicorn.lifespan',
    'uvicorn.logging',
    'uvicorn.loops.auto',
    'uvicorn.loops.uvloop',
    'uvicorn.protocols.http.auto',
    'uvicorn.protocols.http.h11_impl',
    'uvicorn.protocols.websockets.auto',
    'uvicorn.protocols.websockets.wsproto_impl',
    'uvicorn.supervisors.multiprocess',
    'uvicorn.supervisors.statreload',
]

