from playwright.sync_api import sync_playwright, expect

def run_verification():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()

        try:
            # Navigate to the traffic logs page
            page.goto("http://localhost:8000/traffic-logs")

            # Wait for the main content to be visible
            expect(page.locator(".box:has-text('트래픽 로그')")).to_be_visible(timeout=10000)

            # Wait for the proxy selector to be populated
            expect(page.locator("#tlProxySelect option")).not_to_have_count(1, timeout=15000) # Wait for more than the placeholder

            try:
                # Try to select the first available proxy. This will fail if no proxies are enabled.
                page.select_option("#tlProxySelect", index=1, timeout=5000) # Short timeout
            except Exception:
                print("No enabled proxies found to select. Skipping grid test.")
                page.screenshot(path="jules-scratch/verification/traffic_logs_no_proxies.png")
                browser.close()
                return

            # Click the "조회" button
            page.click("#tlLoadBtn")

            # Wait for the grid to be populated with at least one row
            expect(page.locator(".ag-row").first).to_be_visible(timeout=30000)

            # Take a screenshot
            page.screenshot(path="jules-scratch/verification/traffic_logs.png")

            print("Verification script completed successfully.")

        except Exception as e:
            print(f"An error occurred during verification: {e}")
            # Take a screenshot on error to help debug
            page.screenshot(path="jules-scratch/verification/traffic_logs_error.png")

        finally:
            browser.close()

if __name__ == "__main__":
    run_verification()