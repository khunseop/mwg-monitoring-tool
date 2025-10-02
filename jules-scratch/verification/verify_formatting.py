import asyncio
from playwright.async_api import async_playwright, expect

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()

        try:
            # 1. Navigate and clear state
            await page.goto("http://localhost:8000/resource", timeout=60000)
            await page.evaluate("localStorage.clear()")
            await page.reload()

            # 2. Locate controls
            group_control = page.locator('.ts-control').first
            proxy_control = page.locator('.ts-control').nth(1)
            interval_input = page.locator("#ruIntervalSec")
            start_button = page.locator("#ruStartBtn")
            await expect(group_control).to_be_visible(timeout=15000)

            # 3. Set a short interval for testing
            await interval_input.fill("5")

            # 4. Select the proxy
            await group_control.click()
            group_dropdown = page.locator('.ts-dropdown.single')
            await expect(group_dropdown).to_be_visible(timeout=5000)
            await group_dropdown.get_by_role('option', name='전체').click()

            # FIX: Use `to_contain_text` to ignore the 'remove' button (×)
            await expect(proxy_control.locator('.item')).to_contain_text('test-proxy-1', timeout=10000)

            # 5. Start collection
            await start_button.click()

            # The first collection happens immediately and sets the baseline.
            # We wait for the second collection to see the delta values.
            # The interval is 5s, so we wait 6s to be safe.
            print("First collection running... Waiting for the second collection to complete.")
            await asyncio.sleep(6)

            # 6. Verification
            print("Second collection should be complete. Verifying results.")
            await expect(page.locator("#ruHeatmapEl .apexcharts-heatmap-series")).to_be_visible(timeout=15000)

            # Take final screenshot for visual verification of formatting
            await page.screenshot(path="jules-scratch/verification/verification.png")
            print("Screenshot taken successfully.")

        except Exception as e:
            print(f"An error occurred: {e}")
            await page.screenshot(path="jules-scratch/verification/error.png")
            print("Error screenshot taken.")
        finally:
            await browser.close()

if __name__ == "__main__":
    asyncio.run(main())