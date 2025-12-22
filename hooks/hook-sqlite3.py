# PyInstaller hook for sqlite3
# SQLite3 is a standard library module but PyInstaller may not include it properly on Windows

from PyInstaller.utils.hooks import collect_dynamic_libs
import sys
import os

# Collect sqlite3 DLL if it exists
binaries = []

# On Windows, sqlite3.dll may be in Python's DLLs directory
if sys.platform == 'win32':
    python_dlls = os.path.join(sys.prefix, 'DLLs')
    sqlite3_dll = os.path.join(python_dlls, 'sqlite3.dll')
    if os.path.exists(sqlite3_dll):
        binaries.append((sqlite3_dll, '.'))

# Also try to collect from _sqlite3 if available
try:
    _sqlite3_binaries = collect_dynamic_libs('_sqlite3')
    binaries.extend(_sqlite3_binaries)
except Exception:
    pass

hiddenimports = [
    'sqlite3',
    '_sqlite3',
]

