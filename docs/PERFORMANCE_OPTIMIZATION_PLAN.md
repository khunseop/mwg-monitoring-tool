# Performance Optimization Plan: mwg-monitoring-tool

## 1. Overview
The current application faces performance bottlenecks when handling large volumes of data, particularly traffic logs (200k+ lines). The primary issues are:
- **Synchronous Bottleneck:** SSH log collection and DB insertion happen during the HTTP request, causing long wait times and potential timeouts.
- **DB Concurrency:** Frequent `DELETE` and `BULK INSERT` on SQLite during requests can block read operations.
- **Frontend Overhead:** Loading 200k+ rows into the browser's memory (Ag-Grid Client-side) causes freezing and high memory usage.
- **SSH Overhead:** Creating a new SSH session for every request is expensive and slow.

## 2. Core Strategies

### Strategy 1: SSH Connection Pooling & Keep-Alive
Instead of creating a new session per request, maintain a pool of persistent SSH connections.
- **Implementation:** Create an `SSHPool` manager in `app/utils/ssh.py`.
- **Keep-Alive:** Implement a background heartbeat (e.g., sending a null packet every 60s) to prevent the 10-minute timeout.
- **Auto-Reconnect:** Detect closed sessions and reconnect transparently before executing commands.

### Strategy 2: Background Data Ingestion (Producer-Consumer)
Decouple log collection from the UI request.
- **Background Worker:** Use `BackgroundTasks` (FastAPI) or a dedicated asyncio loop to fetch logs from proxies and insert them into the DB in chunks.
- **Chunked Insertion:** Insert data in batches (e.g., 5,000 rows at a time) to keep the DB responsive.
- **Status Tracking:** Provide an API endpoint to check the progress of log collection.

### Strategy 3: Server-Side Processing for Traffic Logs
Leverage SQL for searching and sorting instead of JavaScript.
- **API Extension:** Update `/api/traffic-logs` to support:
  - `offset` and `limit` (Pagination)
  - `sort_by` and `sort_order`
  - `filters` (e.g., filter by IP, URL, or Status Code)
- **Indexing:** Ensure indexes exist on the most frequently searched columns (`client_ip`, `url_host`, `response_statuscode`, etc.) in the `traffic_logs` table.

### Strategy 4: Ag-Grid Server-Side Row Model
Refactor the frontend to fetch only the visible data.
- **Infinite Scrolling:** Configure Ag-Grid to use the `Infinite Row Model`.
- **On-Demand Fetching:** The grid will request the next block of data only when the user scrolls.
- **Remote Operations:** Sorting and filtering in the grid header will trigger a new API call with SQL parameters.

### Strategy 5: WebSocket Stability & Concurrency Optimization
Ensure real-time views (Resource Usage) and heavy tasks (Log Analysis) don't interfere.
- **Async I/O Isolation:** Ensure all heavy SSH/Network I/O operations use `asyncio` correctly without blocking the main event loop that handles WebSockets.
- **Shared Connection Manager:** Use a unified WebSocket manager to handle broadcasts efficiently and prevent memory leaks from stale connections.
- **SQLite Concurrency:** Fine-tune WAL (Write-Ahead Logging) mode and connection timeouts to ensure background writes don't block real-time reads.

## 3. Implementation Phases

### Phase 1: SSH & Backend Foundation
1. Implement `SSHPool` with session caching and keep-alive.
2. Refactor `traffic_logs.py` API to support pagination (`limit`, `offset`), sorting, and filtering.
3. Modify the collection logic to run in the background.
4. Enhance WebSocket manager to ensure stable real-time data delivery during high load.

### Phase 2: Frontend Grid Refactoring
1. Update `ag_grid_config.js` and `traffic_logs.js` to support the `Infinite Row Model`.
2. Connect grid filter/sort events to the new API parameters.
3. Add a loading indicator for background data ingestion.

### Phase 3: Database & Cleanup
1. Optimize SQLite indexes for the `traffic_logs` table.
2. Implement a retention policy to periodically prune old logs if they exceed a certain threshold (to keep the DB file size manageable).

## 4. Expected Outcomes
- **Responsiveness:** UI remains fluid even with 1M+ log entries in the database.
- **Speed:** Log search and sort operations complete in milliseconds via SQL.
- **Stability:** SSH sessions stay active, reducing the "Connecting..." lag.
- **Scalability:** The system can handle more proxies and larger log files without linear performance degradation.
