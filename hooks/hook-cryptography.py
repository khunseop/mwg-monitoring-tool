# PyInstaller hook for cryptography
# This hook ensures OpenSSL DLLs (libcrypto, libssl) are included

from PyInstaller.utils.hooks import collect_submodules, collect_data_files, collect_dynamic_libs
import sys
import os

# Collect all cryptography submodules
hiddenimports = collect_submodules('cryptography')

# Collect data files
datas = collect_data_files('cryptography')

# Collect dynamic libraries (DLLs) - this includes libcrypto and libssl
binaries = []

# Collect from cryptography package
try:
    crypto_binaries = collect_dynamic_libs('cryptography')
    binaries.extend(crypto_binaries)
except Exception:
    pass

# Also collect from _cffi_backend which cryptography uses
try:
    _cffi_binaries = collect_dynamic_libs('_cffi_backend')
    binaries.extend(_cffi_binaries)
except Exception:
    pass

# On Windows, explicitly look for OpenSSL DLLs in common locations
if sys.platform == 'win32':
    # Check Python's DLLs directory
    python_dlls = os.path.join(sys.prefix, 'DLLs')
    for dll_name in ['libcrypto-3-x64.dll', 'libssl-3-x64.dll', 
                     'libcrypto-1_1-x64.dll', 'libssl-1_1-x64.dll',
                     'libcrypto-1_1.dll', 'libssl-1_1.dll']:
        dll_path = os.path.join(python_dlls, dll_name)
        if os.path.exists(dll_path):
            binaries.append((dll_path, '.'))
    
    # Check site-packages/cryptography directory
    try:
        import cryptography
        crypto_path = os.path.dirname(cryptography.__file__)
        for root, dirs, files in os.walk(crypto_path):
            for file in files:
                if file.startswith('libcrypto') or file.startswith('libssl'):
                    if file.endswith('.dll'):
                        binaries.append((os.path.join(root, file), '.'))
    except Exception:
        pass
    
    # Check conda environment if available
    if 'CONDA_PREFIX' in os.environ:
        conda_dlls = os.path.join(os.environ['CONDA_PREFIX'], 'DLLs')
        for dll_name in ['libcrypto-3-x64.dll', 'libssl-3-x64.dll',
                         'libcrypto-1_1-x64.dll', 'libssl-1_1-x64.dll']:
            dll_path = os.path.join(conda_dlls, dll_name)
            if os.path.exists(dll_path):
                binaries.append((dll_path, '.'))
        
        # Also check Library/bin in conda
        conda_bin = os.path.join(os.environ['CONDA_PREFIX'], 'Library', 'bin')
        if os.path.exists(conda_bin):
            for dll_name in ['libcrypto-3-x64.dll', 'libssl-3-x64.dll',
                           'libcrypto-1_1-x64.dll', 'libssl-1_1-x64.dll']:
                dll_path = os.path.join(conda_bin, dll_name)
                if os.path.exists(dll_path):
                    binaries.append((dll_path, '.'))

# Remove duplicates while preserving order
seen = set()
binaries_unique = []
for binary in binaries:
    if binary not in seen:
        seen.add(binary)
        binaries_unique.append(binary)
binaries = binaries_unique

