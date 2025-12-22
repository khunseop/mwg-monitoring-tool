# PyInstaller hook for cryptography
# This hook ensures OpenSSL DLLs (libcrypto, libssl) are included

from PyInstaller.utils.hooks import collect_submodules, collect_data_files, collect_dynamic_libs

# Collect all cryptography submodules
hiddenimports = collect_submodules('cryptography')

# Collect data files
datas = collect_data_files('cryptography')

# Collect dynamic libraries (DLLs) - this includes libcrypto and libssl
binaries = collect_dynamic_libs('cryptography')

# Also collect from _cffi_backend which cryptography uses
try:
    _cffi_binaries = collect_dynamic_libs('_cffi_backend')
    binaries.extend(_cffi_binaries)
except Exception:
    pass

