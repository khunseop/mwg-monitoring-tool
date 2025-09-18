from PyInstaller.utils.hooks import collect_submodules, collect_data_files, copy_metadata

hiddenimports = collect_submodules('paramiko')
datas = collect_data_files('paramiko') + copy_metadata('paramiko')

