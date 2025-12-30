(function(window){
	'use strict';

	// ag-grid 공통 설정 모듈
	var AgGridConfig = {
		// 기본 컬럼 정의 (세션브라우저용)
		getSessionBrowserColumns: function() {
			return [
				{ field: 'host', headerName: '프록시', sortable: true, filter: 'agTextColumnFilter', filterParams: { applyButton: true, clearButton: true }, minWidth: 120, width: 150 },
				{ field: 'creation_time', headerName: '생성시각', sortable: true, filter: 'agTextColumnFilter', filterParams: { applyButton: true, clearButton: true }, minWidth: 160, width: 180,
					valueFormatter: function(params) {
						return (window.AppUtils && AppUtils.formatDateTime) ? AppUtils.formatDateTime(params.value) : params.value;
					}
				},
				{ field: 'protocol', headerName: '프로토콜', sortable: true, filter: 'agTextColumnFilter', filterParams: { applyButton: true, clearButton: true }, minWidth: 90, width: 100 },
				{ field: 'user_name', headerName: '사용자', sortable: true, filter: 'agTextColumnFilter', filterParams: { applyButton: true, clearButton: true }, minWidth: 100, width: 120 },
				{ field: 'client_ip', headerName: '클라이언트 IP', sortable: true, filter: 'agTextColumnFilter', filterParams: { applyButton: true, clearButton: true }, minWidth: 130, width: 140, cellClass: 'mono' },
				{ field: 'server_ip', headerName: '서버 IP', sortable: true, filter: 'agTextColumnFilter', filterParams: { applyButton: true, clearButton: true }, minWidth: 130, width: 140, cellClass: 'mono' },
				{ field: 'cl_bytes_received', headerName: 'CL 수신', sortable: true, filter: 'agNumberColumnFilter', filterParams: { applyButton: true, clearButton: true }, minWidth: 100, width: 120, cellClass: 'num',
					valueFormatter: function(params) {
						return (window.AppUtils && AppUtils.formatBytes) ? AppUtils.formatBytes(params.value) : params.value;
					}
				},
				{ field: 'cl_bytes_sent', headerName: 'CL 송신', sortable: true, filter: 'agNumberColumnFilter', filterParams: { applyButton: true, clearButton: true }, minWidth: 100, width: 120, cellClass: 'num',
					valueFormatter: function(params) {
						return (window.AppUtils && AppUtils.formatBytes) ? AppUtils.formatBytes(params.value) : params.value;
					}
				},
				{ field: 'age_seconds', headerName: 'Age(s)', sortable: true, filter: 'agNumberColumnFilter', filterParams: { applyButton: true, clearButton: true }, minWidth: 80, width: 100,
					valueFormatter: function(params) {
						return (window.AppUtils && AppUtils.formatSeconds) ? AppUtils.formatSeconds(params.value) : params.value;
					}
				},
				{ field: 'url', headerName: 'URL', sortable: true, filter: 'agTextColumnFilter', filterParams: { applyButton: true, clearButton: true }, minWidth: 200, flex: 1, 
					cellRenderer: function(params) {
						if (!params.value) return '';
						var url = String(params.value);
						var short = url.length > 100 ? url.substring(0, 100) + '…' : url;
						return '<div style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="' + url.replace(/"/g, '&quot;') + '">' + short + '</div>';
					}
				},
				{ field: 'id', headerName: 'id', hide: true }
			];
		},

		// 자원사용률 이력용 컬럼 정의
		getResourceHistoryColumns: function() {
			return [
				{ field: 'collected_at', headerName: '수집 시간', sortable: true, filter: 'agTextColumnFilter', filterParams: { applyButton: true, clearButton: true }, minWidth: 150, width: 180,
					valueFormatter: function(params) {
						if (!params.value) return '';
						const date = new Date(params.value);
						return date.toLocaleString('ko-KR', {
							year: 'numeric',
							month: '2-digit',
							day: '2-digit',
							hour: '2-digit',
							minute: '2-digit',
							second: '2-digit'
						});
					}
				},
				{ field: 'proxy_name', headerName: '프록시', sortable: true, filter: 'agTextColumnFilter', filterParams: { applyButton: true, clearButton: true }, minWidth: 120, width: 150 },
				{ field: 'cpu', headerName: 'CPU (%)', sortable: true, filter: 'agNumberColumnFilter', filterParams: { applyButton: true, clearButton: true }, minWidth: 80, width: 100, cellClass: 'num',
					valueFormatter: function(params) {
						return params.value != null ? params.value.toFixed(1) : '-';
					}
				},
				{ field: 'mem', headerName: 'MEM (%)', sortable: true, filter: 'agNumberColumnFilter', filterParams: { applyButton: true, clearButton: true }, minWidth: 80, width: 100, cellClass: 'num',
					valueFormatter: function(params) {
						return params.value != null ? params.value.toFixed(1) : '-';
					}
				},
				{ field: 'cc', headerName: 'CC', sortable: true, filter: 'agNumberColumnFilter', filterParams: { applyButton: true, clearButton: true }, minWidth: 100, width: 120, cellClass: 'num',
					valueFormatter: function(params) {
						if (params.value == null) return '-';
						return params.value.toString().replace(/(\d)(?=(\d{3})+(?!\d))/g, '$1,');
					}
				},
				{ field: 'cs', headerName: 'CS', sortable: true, filter: 'agNumberColumnFilter', filterParams: { applyButton: true, clearButton: true }, minWidth: 100, width: 120, cellClass: 'num',
					valueFormatter: function(params) {
						if (params.value == null) return '-';
						return params.value.toString().replace(/(\d)(?=(\d{3})+(?!\d))/g, '$1,');
					}
				},
				{ field: 'http', headerName: 'HTTP (누적)', sortable: true, filter: 'agNumberColumnFilter', filterParams: { applyButton: true, clearButton: true }, minWidth: 120, width: 150, cellClass: 'num',
					valueFormatter: function(params) {
						if (params.value == null || params.value === undefined) return '-';
						const bytes = params.value;
						if (bytes === 0) return '0 Bytes';
						const k = 1024;
						const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
						const i = Math.floor(Math.log(bytes) / Math.log(k));
						const size = i >= sizes.length ? sizes[sizes.length - 1] : sizes[i];
						return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + size;
					}
				},
				{ field: 'https', headerName: 'HTTPS (누적)', sortable: true, filter: 'agNumberColumnFilter', filterParams: { applyButton: true, clearButton: true }, minWidth: 120, width: 150, cellClass: 'num',
					valueFormatter: function(params) {
						if (params.value == null || params.value === undefined) return '-';
						const bytes = params.value;
						if (bytes === 0) return '0 Bytes';
						const k = 1024;
						const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
						const i = Math.floor(Math.log(bytes) / Math.log(k));
						const size = i >= sizes.length ? sizes[sizes.length - 1] : sizes[i];
						return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + size;
					}
				},
				{ field: 'ftp', headerName: 'FTP (누적)', sortable: true, filter: 'agNumberColumnFilter', filterParams: { applyButton: true, clearButton: true }, minWidth: 120, width: 150, cellClass: 'num',
					valueFormatter: function(params) {
						if (params.value == null || params.value === undefined) return '-';
						const bytes = params.value;
						if (bytes === 0) return '0 Bytes';
						const k = 1024;
						const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
						const i = Math.floor(Math.log(bytes) / Math.log(k));
						const size = i >= sizes.length ? sizes[sizes.length - 1] : sizes[i];
						return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + size;
					}
				},
				{ field: 'interface_mbps', headerName: '인터페이스', sortable: false, filter: false, minWidth: 200, flex: 1,
					cellRenderer: function(params) {
						if (!params.value || typeof params.value !== 'object') return '-';
						const utils = window.ResourceUsageUtils;
						const parts = [];
						Object.keys(params.value).forEach(ifName => {
							const ifData = params.value[ifName];
							if (ifData && typeof ifData === 'object') {
								const name = ifName.length > 20 ? ifName.substring(0, 17) + '...' : ifName;
								const inMbps = typeof ifData.in_mbps === 'number' ? ifData.in_mbps : 0;
								const outMbps = typeof ifData.out_mbps === 'number' ? ifData.out_mbps : 0;
								const bpsIn = utils.mbpsToBps(inMbps);
								const bpsOut = utils.mbpsToBps(outMbps);
								parts.push(`${name}: ${utils.formatBps(bpsIn, 2)}/${utils.formatBps(bpsOut, 2)}`);
							}
						});
						return parts.length > 0 ? parts.join(', ') : '-';
					},
					cellStyle: { fontSize: '0.85em' }
				}
			];
		},

		// 트래픽로그용 컬럼 정의
		getTrafficLogColumns: function() {
			var COLS = [
				"datetime","username","client_ip","url_destination_ip","timeintransaction",
				"response_statuscode","cache_status","comm_name","url_protocol","url_host",
				"url_path","url_parametersstring","url_port","url_categories","url_reputationstring",
				"url_reputation","mediatype_header","recv_byte","sent_byte","user_agent","referer",
				"url_geolocation","application_name","currentruleset","currentrule","action_names",
				"block_id","proxy_id","ssl_certificate_cn","ssl_certificate_sigmethod",
				"web_socket","content_lenght"
			];
			
			return COLS.map(function(col) {
				var colDef = {
					field: col,
					headerName: col,
					sortable: true,
					filter: 'agTextColumnFilter',
					filterParams: { applyButton: true, clearButton: true },
					minWidth: 120,
					width: 150
				};
				
				// 특정 컬럼에 대한 포맷터 설정
				if (col === 'datetime' || col === 'collected_at') {
					colDef.valueFormatter = function(params) {
						return (window.AppUtils && AppUtils.formatDateTime) ? AppUtils.formatDateTime(params.value) : params.value;
					};
				} else if (col === 'response_statuscode') {
					colDef.cellRenderer = function(params) {
						return (window.AppUtils && AppUtils.renderStatusTag) ? AppUtils.renderStatusTag(params.value) : String(params.value || '');
					};
					colDef.cellClass = 'mono';
				} else if (col === 'recv_byte' || col === 'sent_byte' || col === 'content_lenght') {
					colDef.valueFormatter = function(params) {
						return (window.AppUtils && AppUtils.formatBytes) ? AppUtils.formatBytes(params.value) : params.value;
					};
					colDef.cellClass = 'num';
				} else if (col === 'timeintransaction') {
					colDef.valueFormatter = function(params) {
						var num = Number(params.value);
						if (Number.isFinite(num)) {
							var msVal = num < 1000 ? num * 1000 : num;
							return (window.AppUtils && AppUtils.formatDurationMs) ? AppUtils.formatDurationMs(msVal) : params.value;
						}
						return params.value;
					};
				}
				
				// URL 관련 컬럼은 긴 텍스트 처리
				if (col === 'url_path' || col === 'url_parametersstring' || col === 'referer' || col === 'url_host' || col === 'user_agent') {
					colDef.minWidth = 200;
					colDef.flex = 1;
					colDef.cellRenderer = function(params) {
						if (!params.value) return '';
						var val = String(params.value);
						return '<div style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="' + val.replace(/"/g, '&quot;') + '">' + val + '</div>';
					};
				}
				
				// 숫자 컬럼은 숫자 필터 사용
				if (col === 'recv_byte' || col === 'sent_byte' || col === 'content_lenght' || col === 'timeintransaction' || col === 'response_statuscode') {
					colDef.filter = 'agNumberColumnFilter';
				}
				
				return colDef;
			});
		},

		// 서버사이드 기본 설정
		getServerSideDefaultOptions: function() {
			return {
				rowModelType: 'serverSide',
				serverSideInfiniteScroll: true,
				cacheBlockSize: 25,
				pagination: true,
				paginationPageSize: 25,
				enableFilter: true,
				enableSorting: true,
				animateRows: false,
				suppressRowClickSelection: false,
				domLayout: 'normal',
				defaultColDef: {
					sortable: true,
					filter: true,
					resizable: true,
				}
			};
		},

		// 클라이언트사이드 기본 설정
		getClientSideDefaultOptions: function() {
			return {
				rowModelType: 'clientSide',
				pagination: true,
				paginationPageSize: 25,
				enableFilter: true,
				enableSorting: true,
				animateRows: false,
				suppressRowClickSelection: false,
				domLayout: 'normal',
				defaultColDef: {
					sortable: true,
					filter: 'agTextColumnFilter',
					filterParams: { applyButton: true, clearButton: true },
					resizable: true,
					minWidth: 100
				}
			};
		}
	};

	window.AgGridConfig = AgGridConfig;

})(window);
