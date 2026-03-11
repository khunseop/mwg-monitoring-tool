(function(window, $) {
    'use strict';

    const tla = {
        gridApi: null,
        records: []
    };

    function initLogAnalysis() {
        // 파일 선택 시 이름 표시
        $('#tlaFileInput').off('change').on('change', function() {
            const file = this.files[0];
            if (file) {
                $('#tlaFileName').text(file.name);
            } else {
                $('#tlaFileName').text('선택된 파일 없음');
            }
        });

        // 분석 시작 버튼
        $('#tlaRunBtn').off('click').on('click', function() {
            const fileInput = document.getElementById('tlaFileInput');
            if (!fileInput.files.length) {
                alert('분석할 로그 파일을 선택하세요.');
                return;
            }

            const formData = new FormData();
            formData.append('logfile', fileInput.files[0]);

            $(this).addClass('is-loading');
            $('#tlStatus').text('파일 분석 중...').removeClass('is-primary').addClass('is-warning');

            $.ajax({
                url: '/api/traffic-logs/analyze-upload',
                method: 'POST',
                data: formData,
                processData: false,
                contentType: false,
                success: (res) => {
                    tla.records = res.records || [];
                    renderAnalysisTable(tla.records);
                    $('#tlStatus').text(`분석 완료 (${tla.records.length}건)`).removeClass('is-warning').addClass('is-primary');
                    // 분석 완료 후 섹션 표시 (기존 로그조회 그리드 활용)
                    $('#tlResultParsed').fadeIn();
                    $('#tlEmptyState').hide();
                },
                error: (xhr) => {
                    alert('파일 분석 실패: ' + (xhr.responseJSON?.detail || '알 수 없는 오류'));
                    $('#tlStatus').text('분석 실패').removeClass('is-warning').addClass('is-danger');
                },
                complete: () => {
                    $(this).removeClass('is-loading');
                }
            });
        });
    }

    function renderAnalysisTable(records) {
        if (!window.agGrid) return;
        
        // 로그 조회 페이지의 그리드 구조를 재사용
        const gridDiv = document.querySelector('#tlTableGrid');
        if (!gridDiv) return;

        // 기존 인스턴스가 있으면 파괴 후 재생성 (헤더 등이 다를 수 있음)
        if (gridDiv.innerHTML !== "") {
            gridDiv.innerHTML = "";
        }

        const gridOptions = {
            columnDefs: window.AgGridConfig ? window.AgGridConfig.getTrafficLogColumns() : [],
            defaultColDef: {
                resizable: true,
                sortable: true,
                filter: true,
                minWidth: 100
            },
            rowData: records,
            pagination: true,
            paginationPageSize: 100,
            rowHeight: 35,
            headerHeight: 45,
            onRowDoubleClicked: params => {
                if (window.showTrafficLogDetail) window.showTrafficLogDetail(params.data);
            }
        };
        window.agGrid.createGrid(gridDiv, gridOptions);
    }

    // 초기화
    $(document).ready(() => {
        initLogAnalysis();
    });

    // PJAX 지원
    $(document).off('pjax:complete.tla').on('pjax:complete.tla', function(e, url) {
        if (url.includes('/traffic-logs/upload')) {
            initLogAnalysis();
        }
    });

})(window, jQuery);
