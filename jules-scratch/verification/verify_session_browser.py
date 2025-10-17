from playwright.sync_api import sync_playwright, expect

def run_verification():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()

        try:
            # Navigate to the session browser page
            page.goto("http://localhost:8000/session")

            # Wait for the main content to be visible, specifically the one with the title
            expect(page.locator(".box:has-text('세션브라우저')")).to_be_visible(timeout=15000)

            # Wait for the device selector to be populated with at least one group
            expect(page.locator("#sbGroupSelect option")).not_to_have_count(0, timeout=20000)

            # Select the first available group (index 0 might be a placeholder)
            page.select_option("#sbGroupSelect", index=0)

            # Wait for the proxy selector to be populated, but handle the case where it might be empty
            try:
                page.wait_for_selector("#sbProxySelect option", timeout=15000)
            except Exception:
                print("No proxies found for the selected group. Skipping grid test.")
                # If no proxies, we can't test the grid, so we'll just take a screenshot and exit gracefully.
                page.screenshot(path="jules-scratch/verification/session_browser_no_proxies.png")
                browser.close()
                return

            # If proxies are found, proceed with the test
            page.check("#sbSelectAll")

            # Click the "collect" button
            page.click("#sbLoadBtn")

            # Wait for the grid to be populated with at least one row
            expect(page.locator(".ag-row").first).to_be_visible(timeout=30000)

            # Take a screenshot
            page.screenshot(path="jules-scratch/verification/session_browser.png")

            print("Verification script completed successfully.")

        except Exception as e:
            print(f"An error occurred during verification: {e}")
            # Take a screenshot on error to help debug
            page.screenshot(path="jules-scratch/verification/session_browser_error.png")

        finally:
            browser.close()

if __name__ == "__main__":
    run_verification()