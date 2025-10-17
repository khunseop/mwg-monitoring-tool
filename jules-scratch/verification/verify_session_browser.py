from playwright.sync_api import sync_playwright, expect

def run_verification():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()

        try:
            # Navigate to the session browser page
            page.goto("http://localhost:8000/session", wait_until="networkidle")

            # Wait for TomSelect to be initialized on the group selector
            page.wait_for_function("document.querySelector('#sbGroupSelect')._tom")

            # Click the group selector to open the dropdown
            page.locator('#sbGroupSelect + .ts-control').click()

            # Click the first option in the dropdown
            page.locator('.ts-dropdown [data-selectable]').first.click()

            # Wait for TomSelect to be initialized on the proxy selector
            page.wait_for_function("document.querySelector('#sbProxySelect')._tom")

            # Click the proxy selector to open the dropdown
            page.locator('#sbProxySelect + .ts-control').click()

            # Click the first proxy in the dropdown
            page.locator('.ts-dropdown [data-selectable]').first.click()

            # Click the load button to trigger data collection
            page.locator('#sbLoadBtn').click()

            # Wait for the collection to finish and the grid to potentially reload
            # We expect a status message to appear.
            expect(page.locator('#sbStatus')).to_have_text('완료', timeout=20000)

            # Now, check if the grid has rows.
            # This part might still fail if no data is loaded, but it's our verification point.
            row_count = page.locator('.ag-row').count()
            print(f"Found {row_count} rows in the grid.")

            # Take a screenshot regardless of row count
            page.screenshot(path="jules-scratch/verification/verification.png")

        except Exception as e:
            print(f"An error occurred: {e}")
            page.screenshot(path="jules-scratch/verification/error.png")
        finally:
            browser.close()

if __name__ == "__main__":
    run_verification()