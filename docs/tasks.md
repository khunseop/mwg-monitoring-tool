1. 보안 및 무결성 강화 (완료)
 * 패스워드 보안 강화: proxies 테이블의 패스워드는 암호화(Fernet)하여 저장하고, 백엔드에서만 복호화가 가능하도록 처리합니다. 기존 평문은 서버 시작 시 1회 자동 암호화합니다. 키는 `PROXY_PASSWORD_KEY` 혹은 `./.secret/proxy_key.key`를 사용합니다.
 * 설정값 수정 방지: session_browser_config 테이블의 `command_path`, `command_args`는 변경 불가로 고정하여 중요한 앱 설정이 변경되지 않도록 합니다.
2. 데이터 관리 및 성능 최적화
 * 로그 및 세션 기록 관리: 전체 삭제 대신 '스냅샷 키(import_batch_id)'로 구분합니다. 새로 불러오기는 최신 스냅샷을 활성화하고 이전 스냅샷은 7일 보관 후 야간 배치로 제거합니다. 조회 성능 향상을 위해 `traffic_logs(recorded_at, import_batch_id)`, `session_records(started_at, import_batch_id)` 인덱스를 추가합니다.
 * 자원 사용량 데이터 효율화: 원본은 7일 보관하고 이후 5분 단위로 다운샘플링하여 최대 30일 보관합니다. 30일 초과분은 매일 02:00 UTC에 삭제합니다. 그래프는 기간에 따라 자동 리샘플링하며, 실시간 히트맵은 현행 유지합니다. 조회 성능을 위해 `resource_usage(measured_at)` 또는 `(agent_id, measured_at)` 인덱스를 사용합니다.
3. 데이터 구조 개선
 * 데이터 형식 통일: 날짜, 시간, 용량, 액션 등은 데이터 분석에 용이한 형식으로 파싱하여 저장합니다.
 * 설정값 분리: resource_config 테이블에서 oid와 thresholds 값을 분리하여 관리합니다.
