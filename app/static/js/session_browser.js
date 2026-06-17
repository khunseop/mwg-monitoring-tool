(function() {
    'use strict';

    function switchSbTab(tabId) {
        $('.sb-tab-content').hide();
        $('.subnav-tab').removeClass('is-active');
        
        if (tabId === 'list') {
            $('#sbListSection').show();
            $('#sb-tab-list').addClass('is-active');
            // 그리드 리사이즈 유도
            setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
        } else if (tabId === 'analyze') {
            $('#sbAnalyzeSection').show();
            $('#sb-tab-analyze').addClass('is-active');
            // 분석 탭으로 전환 시 현재 데이터가 있으면 자동 분석 실행
            if (sb.records && sb.records.length > 0) {
                analyzeSessions(sb.records);
            }
            // 차트 리사이즈 유도
            setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
        }
    }
    window.switchSbTab = switchSbTab;

    const sb = {
        groups: [],
        proxies: [],
        records: [],
        gridApi: null,
        storageKey: 'sb_state_v1',
        charts: {}
    };

    const COLS = [
        "id", "host", "creation_time", "client_ip", "server_ip",
        "protocol", "status", "user_name", "url", "cl_bytes_received", "cl_bytes_sent",
        "age_seconds"
    ];

    function setStatus(text, cls) {
        const $tag = $('#sbStatus');
        $tag.text(text);
        $tag.removeClass().addClass('tag');
        
        // Apply standardized classes
        if (cls && cls.includes('primary')) $tag.addClass('is-success is-light');
        else if (cls && cls.includes('warning')) $tag.addClass('is-collecting');
        else if (cls && cls.includes('danger')) $tag.addClass('is-danger is-light');
        else if (cls && cls.includes('info')) $tag.addClass('is-info is-light');
        else $tag.addClass('is-ready');
    }

    function detectSessionAnomalies(records) {
        const anomalies = [];
        if (!records || records.length === 0) return anomalies;

        const fmt = (v) => (window.AppUtils && AppUtils.formatBytes) ? AppUtils.formatBytes(v) : `${v}B`;
        const fmtAge = (s) => s >= 3600 ? `${(s / 3600).toFixed(1)}시간` : `${Math.floor(s / 60)}분 ${s % 60}초`;

        function sigma(values) {
            if (!values.length) return { mean: 0, std: 0 };
            const mean = values.reduce((a, b) => a + b, 0) / values.length;
            const std = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
            return { mean, std };
        }

        const clientStats = {};
        const longSessions = [];

        records.forEach(rec => {
            const ip = rec.client_ip;
            if (ip) {
                if (!clientStats[ip]) clientStats[ip] = { sessions: 0, recv: 0, sent: 0 };
                clientStats[ip].sessions++;
                clientStats[ip].recv += (rec.cl_bytes_received || 0);
                clientStats[ip].sent += (rec.cl_bytes_sent || 0);
            }
            const age = rec.age_seconds;
            if (age && age > 3600) longSessions.push(rec);
        });

        const clientList = Object.entries(clientStats);
        const sessStat = sigma(clientList.map(([, c]) => c.sessions));
        const trafficStat = sigma(clientList.map(([, c]) => c.recv + c.sent));

        // 장기 세션
        longSessions.sort((a, b) => (b.age_seconds || 0) - (a.age_seconds || 0));
        longSessions.slice(0, 5).forEach(rec => {
            const age = rec.age_seconds;
            anomalies.push({
                severity: age > 7200 ? 'critical' : 'warning',
                label: '장기 세션',
                subject: rec.client_ip || '-',
                detail: `${fmtAge(age)} 유지 · ${rec.url ? rec.url.substring(0, 60) : '-'}`,
                _sv: age,
            });
        });

        // 세션 수 과다 (> 평균+2σ)
        clientList.forEach(([ip, stat]) => {
            if (sessStat.std > 0) {
                const z = (stat.sessions - sessStat.mean) / sessStat.std;
                if (z > 2) {
                    anomalies.push({
                        severity: z > 3 ? 'critical' : 'warning',
                        label: '세션 과다',
                        subject: ip,
                        detail: `${stat.sessions.toLocaleString()}개 세션 (평균 대비 ${z.toFixed(1)}σ)`,
                        _sv: z,
                    });
                }
            }
        });

        // 트래픽 과다 (> 평균+2σ)
        clientList.forEach(([ip, stat]) => {
            const traffic = stat.recv + stat.sent;
            if (trafficStat.std > 0) {
                const z = (traffic - trafficStat.mean) / trafficStat.std;
                if (z > 2) {
                    anomalies.push({
                        severity: z > 3 ? 'critical' : 'warning',
                        label: '트래픽 과다',
                        subject: ip,
                        detail: `수신+송신 ${fmt(traffic)} (평균 대비 ${z.toFixed(1)}σ)`,
                        _sv: z,
                    });
                }
            }
        });

        anomalies.sort((a, b) => (a.severity === 'critical' ? 0 : 1) - (b.severity === 'critical' ? 0 : 1) || (b._sv || 0) - (a._sv || 0));
        anomalies.forEach(a => delete a._sv);
        return anomalies;
    }

    function renderAnomalies(anomalies, sectionId, listId, countId, dotId) {
        const $section = $(`#${sectionId}`);
        const $list = $(`#${listId}`);
        $list.empty();

        if (!anomalies || anomalies.length === 0) {
            $section.hide();
            return;
        }

        const hasCritical = anomalies.some(a => a.severity === 'critical');
        const borderColor = hasCritical ? '#dc2626' : '#d97706';
        $section.css('border-left', `4px solid ${borderColor}`);
        $(`#${dotId}`).css('background', borderColor);
        $(`#${countId}`).text(`${anomalies.length}건`).removeClass('is-danger is-warning').addClass(hasCritical ? 'is-danger' : 'is-warning');

        anomalies.forEach((a, i) => {
            const tagCls = a.severity === 'critical' ? 'is-danger' : 'is-warning';
            const isLast = i === anomalies.length - 1;
            const subj = String(a.subject || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
            const detail = String(a.detail || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
            $list.append(`
                <div class="is-flex is-align-items-center py-2" style="${isLast ? '' : 'border-bottom: 1px solid var(--color-border);'} gap: 0.65rem;">
                    <span class="tag ${tagCls} is-small" style="min-width: 60px; justify-content: center; flex-shrink: 0;">${a.label}</span>
                    <code class="is-size-7" style="min-width: 105px; flex-shrink: 0;">${subj}</code>
                    <span class="is-size-7 has-text-grey">${detail}</span>
                </div>`);
        });

        $section.show();
    }

    function analyzeSessions(records) {
        if (!records || records.length === 0) {
            $('#sbaDashboard').hide();
            $('#sbaEmptyState').show();
            return;
        }

        $('#sbaEmptyState').hide();
        $('#sbaDashboard').show();

        const fmt = (v) => (window.AppUtils && AppUtils.formatBytes) ? AppUtils.formatBytes(v) : String(v || 0);

        const stats = {
            total: records.length,
            uniqueClients: new Set(),
            uniqueServers: new Set(),
            totalTraffic: 0,
            proxyDist: {},
            protocolDist: {},
            clientCounts: {},
            clientRecv: {},
            clientSent: {},
            serverCounts: {}
        };

        records.forEach(rec => {
            if (rec.client_ip) {
                stats.uniqueClients.add(rec.client_ip);
                stats.clientCounts[rec.client_ip] = (stats.clientCounts[rec.client_ip] || 0) + 1;
                stats.clientRecv[rec.client_ip] = (stats.clientRecv[rec.client_ip] || 0) + (rec.cl_bytes_received || 0);
                stats.clientSent[rec.client_ip] = (stats.clientSent[rec.client_ip] || 0) + (rec.cl_bytes_sent || 0);
            }
            if (rec.server_ip) {
                stats.uniqueServers.add(rec.server_ip);
                stats.serverCounts[rec.server_ip] = (stats.serverCounts[rec.server_ip] || 0) + 1;
            }

            const traffic = (rec.cl_bytes_received || 0) + (rec.cl_bytes_sent || 0);
            stats.totalTraffic += traffic;

            const proxy = rec.host || 'Unknown';
            stats.proxyDist[proxy] = (stats.proxyDist[proxy] || 0) + 1;

            const proto = rec.protocol || 'Unknown';
            stats.protocolDist[proto] = (stats.protocolDist[proto] || 0) + 1;
        });

        // 이상 징후 탐지
        const anomalies = detectSessionAnomalies(records);
        renderAnomalies(anomalies, 'sba-anomaly-section', 'sba-anomaly-list', 'sba-anomaly-count', 'sba-anomaly-severity-dot');

        // 요약 카드
        $('#sb-stat-total').text(stats.total.toLocaleString());
        $('#sb-stat-unique-clients').text(stats.uniqueClients.size.toLocaleString());
        $('#sb-stat-unique-servers').text(stats.uniqueServers.size.toLocaleString());
        $('#sb-stat-traffic').text(fmt(stats.totalTraffic));

        // 차트 (Top 20)
        renderPieChart('sb-chart-proxy', stats.proxyDist, '프록시');
        renderPieChart('sb-chart-protocol', stats.protocolDist, '프로토콜', true);
        renderBarChart('sb-chart-top-clients', stats.clientCounts, '클라이언트 (Top 20)', 20);
        renderBarChart('sb-chart-top-servers', stats.serverCounts, '서버 IP (Top 20)', 20);

        // 전체 통계 테이블 - 클라이언트
        const sortedClients = Object.entries(stats.clientCounts).sort((a, b) => b[1] - a[1]);
        const $ctbody = $('#sb-stats-clients-tbody');
        $ctbody.empty();
        sortedClients.forEach(([ip, cnt]) => {
            $ctbody.append(
                `<tr><td>${ip}</td><td class="has-text-right">${cnt.toLocaleString()}</td>` +
                `<td class="has-text-right">${fmt(stats.clientRecv[ip] || 0)}</td>` +
                `<td class="has-text-right">${fmt(stats.clientSent[ip] || 0)}</td></tr>`
            );
        });
        $('#sb-clients-count').text(`${sortedClients.length.toLocaleString()}개`);

        // 전체 통계 테이블 - 서버 IP
        const sortedServers = Object.entries(stats.serverCounts).sort((a, b) => b[1] - a[1]);
        const $stbody = $('#sb-stats-servers-tbody');
        $stbody.empty();
        sortedServers.forEach(([ip, cnt]) => {
            $stbody.append(`<tr><td>${ip}</td><td class="has-text-right">${cnt.toLocaleString()}</td></tr>`);
        });
        $('#sb-servers-count').text(`${sortedServers.length.toLocaleString()}개`);

        // CSV 내보내기 핸들러 저장
        sb._lastAnalysisStats = { sortedClients, sortedServers, stats };
    }

    function exportClientsCsv() {
        const d = sb._lastAnalysisStats;
        if (!d) { alert('먼저 분석을 실행하세요.'); return; }
        const fmt = (v) => String(v || 0);
        const headers = ['클라이언트 IP', '세션 수', '수신(CL Bytes)', '송신(CL Bytes)'];
        const rows = d.sortedClients.map(([ip, cnt]) => [ip, cnt, d.stats.clientRecv[ip] || 0, d.stats.clientSent[ip] || 0]);
        downloadCsv(headers, rows, 'sb_clients_stats.csv');
    }

    function exportServersCsv() {
        const d = sb._lastAnalysisStats;
        if (!d) { alert('먼저 분석을 실행하세요.'); return; }
        const headers = ['서버 IP', '세션 수'];
        const rows = d.sortedServers.map(([ip, cnt]) => [ip, cnt]);
        downloadCsv(headers, rows, 'sb_servers_stats.csv');
    }

    function downloadCsv(headers, rows, filename) {
        const bom = '﻿';
        const lines = [headers.map(h => `"${h}"`).join(',')];
        rows.forEach(row => {
            lines.push(row.map(v => `"${String(v || '').replace(/"/g, '""')}"`).join(','));
        });
        const blob = new Blob([bom + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename; a.click();
        URL.revokeObjectURL(url);
    }

    function renderPieChart(elId, dataMap, label, isDonut = false) {
        const labels = Object.keys(dataMap);
        const series = Object.values(dataMap);
        if (!labels.length) return;

        const options = {
            chart: { type: isDonut ? 'donut' : 'pie', height: 300 },
            labels: labels,
            series: series,
            legend: { position: 'bottom' },
            dataLabels: { enabled: true, formatter: (val) => val.toFixed(1) + "%" }
        };

        if (sb.charts[elId]) {
            sb.charts[elId].updateOptions(options);
        } else {
            const el = document.getElementById(elId);
            if (!el) return;
            sb.charts[elId] = new ApexCharts(el, options);
            sb.charts[elId].render();
        }
    }

    function renderBarChart(elId, dataMap, title, limit = 20) {
        const sorted = Object.entries(dataMap)
            .sort((a, b) => b[1] - a[1])
            .slice(0, limit);

        const categories = sorted.map(x => x[0]);
        const data = sorted.map(x => x[1]);
        if (!categories.length) return;

        const options = {
            chart: { type: 'bar', height: Math.max(300, Math.min(limit * 22, 500)), toolbar: { show: false } },
            plotOptions: { bar: { horizontal: true } },
            series: [{ name: '세션 수', data: data }],
            xaxis: { categories: categories },
            title: { text: title, align: 'center', style: { fontSize: '14px' } }
        };

        if (sb.charts[elId]) {
            sb.charts[elId].updateOptions(options);
        } else {
            const el = document.getElementById(elId);
            if (!el) return;
            sb.charts[elId] = new ApexCharts(el, options);
            sb.charts[elId].render();
        }
    }

    async function showDetail(record) {
        if (!record || !record.id) return;
        
        try {
            // Fetch full details (including raw_line) from server
            const res = await fetch(`/api/session-browser/item/${record.id}`);
            if (!res.ok) throw new Error('상세 정보를 가져오는데 실패했습니다.');
            const fullRecord = await res.json();
            
            const $body = $('#sbDetailBody');
            $body.empty();
            
            // Use a more comprehensive set of fields for detail view
            const detailFields = [
                { key: 'host', label: '프록시' },
                { key: 'transaction', label: '트랜잭션 ID' },
                { key: 'creation_time', label: '생성 시각', format: 'datetime' },
                { key: 'protocol', label: '프로토콜' },
                { key: 'status', label: '상태 코드', format: 'status' },
                { key: 'user_name', label: '사용자' },
                { key: 'cust_id', label: '고객 ID' },
                { key: 'client_ip', label: '클라이언트 IP' },
                { key: 'client_side_mwg_ip', label: 'Client-side MWG IP' },
                { key: 'server_side_mwg_ip', label: 'Server-side MWG IP' },
                { key: 'server_ip', label: '서버 IP' },
                { key: 'cl_bytes_received', label: '클라이언트 수신', format: 'bytes' },
                { key: 'cl_bytes_sent', label: '클라이언트 송신', format: 'bytes' },
                { key: 'srv_bytes_received', label: '서버 수신', format: 'bytes' },
                { key: 'srv_bytes_sent', label: '서버 송신', format: 'bytes' },
                { key: 'trxn_index', label: 'Trxn Index' },
                { key: 'age_seconds', label: '세션 유지(초)', format: 'seconds' },
                { key: 'in_use', label: '사용 중 여부' },
                { key: 'url', label: 'URL' }
            ];

            detailFields.forEach(f => {
                let v = fullRecord[f.key];
                if (v === null || v === undefined) v = '-';
                let formatted = v;
                
                if (f.format === 'datetime') {
                    formatted = (window.AppUtils && AppUtils.formatDateTime) ? AppUtils.formatDateTime(v) : v;
                } else if (f.format === 'bytes') {
                    formatted = (window.AppUtils && AppUtils.formatBytes) ? AppUtils.formatBytes(v) : v;
                } else if (f.format === 'seconds') {
                    formatted = (window.AppUtils && AppUtils.formatSeconds) ? AppUtils.formatSeconds(v) : v;
                } else if (f.format === 'status') {
                    formatted = (window.AppUtils && AppUtils.renderStatusTag) ? AppUtils.renderStatusTag(v) : String(v);
                }
                
                const isLongText = (f.key === 'url');
                const cellStyle = isLongText ? 'style="word-break: break-all; white-space: normal;"' : '';
                
                $body.append(`
                    <tr>
                        <th style="width: 180px; background: #f8fafc; font-size: 0.8rem; color: #64748b;">${f.label}</th>
                        <td ${cellStyle}>${formatted}</td>
                    </tr>
                `);
            });

            // Add raw line at the bottom
            if (fullRecord.raw_line) {
                $body.append(`
                    <tr>
                        <th style="width: 180px; background: #f8fafc; font-size: 0.8rem; color: #64748b;">원본 로그</th>
                        <td style="word-break: break-all; white-space: normal; font-family: monospace; font-size: 0.75rem; background: #f1f5f9;">${fullRecord.raw_line}</td>
                    </tr>
                `);
            }

            $('#sbDetailModal').addClass('is-active');
        } catch (err) {
            console.error('[SessionBrowser] Detail fetch failed:', err);
            alert(err.message);
        }
    }

    function getSelectedProxyIds() {
        const select = document.getElementById('sbProxySelect');
        if (select && select._tom) {
            return select._tom.getValue().map(v => parseInt(v, 10));
        }
        return ($(select).val() || []).map(v => parseInt(v, 10));
    }

    async function loadSessions() {
        const proxyIds = getSelectedProxyIds();
        if (proxyIds.length === 0) {
            alert('조회할 프록시를 선택하세요.');
            return;
        }

        const query = $('#sbQuery').val() || '';

        setStatus('데이터 수집 중...', 'is-warning is-light');
        $('#sbLoadingIndicator').css('display', 'flex'); 
        $('#sbLoadBtn').addClass('is-loading');

        try {
            const res = await fetch('/api/session-browser/load', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    proxy_ids: proxyIds,
                    q: query
                })
            });

            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                throw new Error(errData.detail || '세션 정보를 가져오는데 실패했습니다.');
            }

            const data = await res.json();
            sb.records = data.sessions || [];
            
            // 데이터가 있으면 목록 섹션 표시
            if (sb.records.length > 0) {
                $('#sbListSection').show();
            }

            if (sb.gridApi) {
                sb.gridApi.setGridOption('rowData', sb.records);
            }
            
            setStatus(`성공 (${sb.records.length}건)`, 'is-primary is-light');
            $('#sbRowCount').text(`${sb.records.length.toLocaleString()}건 조회됨`).show();
            await persistState();
        } catch (err) {
            console.error('[SessionBrowser] Load failed:', err);
            alert(err.message);
            setStatus('수집 실패', 'is-danger is-light');
        } finally {
            $('#sbLoadingIndicator').hide();
            $('#sbLoadBtn').removeClass('is-loading');
        }
    }

    async function persistState() {
        try {
            // 1. 세션 데이터는 용량이 크므로 IndexedDB에 저장
            if (window.AppDB) {
                await window.AppDB.set(sb.storageKey + '_records', {
                    records: sb.records,
                    timestamp: new Date().getTime()
                });
            }

            // 2. 선택 상태(proxyIds 등)는 localStorage에 병합 저장 (DeviceSelector와 호환)
            const current = JSON.parse(localStorage.getItem(sb.storageKey) || '{}');
            current.hasRecords = (sb.records.length > 0);
            current.timestamp = new Date().getTime();
            current.query = $('#sbQuery').val(); // 검색어 저장
            localStorage.setItem(sb.storageKey, JSON.stringify(current));
            
        } catch (e) {
            console.warn('[SessionBrowser] Failed to persist state:', e);
        }
    }

    async function restoreState() {
        try {
            // 1. localStorage에서 선택 상태 확인
            const saved = localStorage.getItem(sb.storageKey);
            if (!saved) return;
            
            const meta = JSON.parse(saved);
            if (meta.query) $('#sbQuery').val(meta.query); // 검색어 복원
            
            // 2. 시간 제한 확인 (24시간으로 연장)
            const ttl = 24 * 60 * 60 * 1000;
            if (new Date().getTime() - meta.timestamp > ttl) {
                // 시간 초과 시 데이터만 삭제 (선택 정보는 유지될 수도 있음)
                if (window.AppDB) await window.AppDB.delete(sb.storageKey + '_records');
                return;
            }

            // 2. IndexedDB에서 대용량 세션 데이터 복원
            if (window.AppDB) {
                const data = await window.AppDB.get(sb.storageKey + '_records');
                if (data && data.records && data.records.length > 0) {
                    sb.records = data.records;
                    window.LOG_RECORDS = data.records; // 분석 연동용 전역 변수 업데이트
                    if (sb.gridApi) {
                        sb.gridApi.setGridOption('rowData', sb.records);
                        setStatus(`데이터 복원됨 (${sb.records.length}건)`, 'is-info is-light');
                        $('#sbRowCount').text(`${sb.records.length.toLocaleString()}건 조회됨`).show();
                        // 데이터가 있으면 목록 섹션이 보여야 함
                        $('#sbListSection').show();
                    }
                }
            }

        } catch (e) {
            console.warn('[SessionBrowser] State restore failed', e);
        }
    }

    function initGrid() {
        // PJAX 재실행으로 클로저가 리셋된 경우 window 레벨 참조로 복구 후 destroy
        if (window.__sbGridApi) {
            try { window.__sbGridApi.destroy(); } catch(e) {}
            window.__sbGridApi = null;
        }
        sb.gridApi = null;

        const gridDiv = document.querySelector('#sbTableGrid');
        if (!gridDiv || !window.agGrid) return;

        gridDiv.innerHTML = '';

        const gridOptions = {
            columnDefs: window.AgGridConfig ? window.AgGridConfig.getSessionBrowserColumns() : [],
            defaultColDef: {
                resizable: true,
                sortable: true,
                filter: 'agTextColumnFilter',
                filterParams: { applyButton: true, clearButton: true },
                minWidth: 100
            },
            rowData: [],
            pagination: true,
            paginationPageSize: window.AgGridConfig ? window.AgGridConfig.getPageSize() : 50,
            rowHeight: 35,
            headerHeight: 40,
            animateRows: true,
            onRowDoubleClicked: params => showDetail(params.data),
            enableBrowserTooltips: true,
            overlayNoRowsTemplate: '<div style="padding: 20px; text-align: center; color: var(--color-text-muted); font-size: 0.875rem;">조회된 세션 데이터가 없습니다. 상단에서 "세션 불러오기"를 클릭하세요.</div>',
            onGridReady: async (params) => {
                sb.gridApi = params.api;
                window.__sbGridApi = params.api;
                setTimeout(() => restoreState(), 100);
            }
        };

        sb.gridApi = window.agGrid.createGrid(gridDiv, gridOptions);
        window.__sbGridApi = sb.gridApi;
    }

    function initSessionBrowser() {
        // 설정 로드 및 캐싱 (페이지 크기 등)
        $.get('/api/session-browser/config').done(cfg => {
            localStorage.setItem('sb_config', JSON.stringify(cfg));
        });

        // PJAX 재실행으로 클로저가 리셋된 경우 window 레벨 참조로 복구
        if (!sb.gridApi && window.__sbGridApi) {
            sb.gridApi = window.__sbGridApi;
        }

        const gridDiv = document.querySelector('#sbTableGrid');
        if (!gridDiv) return;

        const hasGridDom = !!gridDiv.querySelector('.ag-root-wrapper');

        if (!hasGridDom) {
            // 그리드 DOM 없음 → 새로 생성
            initGrid();
        } else if (sb.gridApi) {
            // 그리드 DOM 있고 API 참조도 있음 → 상태 복원만
            restoreState();
        } else {
            // 그리드 DOM은 있지만 API 참조 분실 → 재생성
            initGrid();
        }

        // DeviceSelector 초기화
        if (window.DeviceSelector) {
            window.DeviceSelector.init({
                groupSelect: '#sbGroupSelect',
                proxySelect: '#sbProxySelect',
                proxyTrigger: '#sbProxyTrigger',
                deselectBtn: '#sbDeselectAllBtn',
                selectionCounter: '#sbSelectionCounter',
                storageKey: sb.storageKey,
                onData: (data) => {
                    sb.groups = data.groups;
                    sb.proxies = data.proxies;
                }
            });
        }

        // 버튼 이벤트 바인딩 (중복 바인딩 방지)
        $('#sbLoadBtn').off('click').on('click', loadSessions);
        $('#sbAnalyzeBtn').off('click').on('click', () => switchSbTab('analyze'));
        
        $('#sbQuickFilter').off('input').on('input', function() {
            if (sb.gridApi) sb.gridApi.setGridOption('quickFilterText', $(this).val());
        });

        $('#sbClearFilters').off('click').on('click', () => {
            $('#sbQuickFilter').val('');
            if (sb.gridApi) {
                sb.gridApi.setGridOption('quickFilterText', '');
                sb.gridApi.setFilterModel(null);
                // 필터 초기화 피드백
                const originalText = $('#sbClearFilters span').text();
                $('#sbClearFilters span').text('초기화 완료');
                setTimeout(() => $('#sbClearFilters span').text(originalText), 1500);
            }
        });

        $('#sbExportBtn').off('click').on('click', () => {
            if (sb.gridApi) {
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
                sb.gridApi.exportDataAsCsv({ 
                    fileName: `sessions_export_${timestamp}.csv`,
                    allColumns: true,
                    processCellCallback: window.AgGridConfig ? window.AgGridConfig.processCellForExport : null
                });
            }
        });

        $('#sbExportClientsBtn').off('click').on('click', exportClientsCsv);
        $('#sbExportServersBtn').off('click').on('click', exportServersCsv);

        // Modal closing handlers
        $('#sbDetailModal .delete, #sbDetailModal .button, #sbDetailModal .modal-background').off('click').on('click', () => {
            $('#sbDetailModal').removeClass('is-active');
        });
    }

    // 초기화 및 PJAX 지원
    $(document).ready(() => {
        // PJAX 환경에서는 document.ready가 로드 시 한 번만 실행될 수도 있고, 
        // base.js에서 스크립트를 수동으로 실행할 때 즉시 실행될 수도 있음.
        initSessionBrowser();
    });

    // PJAX 페이지 전환 대응 (네임스페이스 사용하여 중복 등록 방지)
    $(document).off('pjax:complete.sb').on('pjax:complete.sb', function(e, url) {
        if (url.includes('/session')) {
            initSessionBrowser();
        }
    });

})();
