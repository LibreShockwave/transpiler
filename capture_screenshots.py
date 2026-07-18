#!/usr/bin/env python3
"""Capture screenshots of the TS export and the C++ WASM oracle."""

import sys
import time
from pathlib import Path

from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC

OUT_DIR = Path("/tmp/habbo_screenshots")
OUT_DIR.mkdir(exist_ok=True)

URLS = {
    "ts": "http://localhost:5173/",
    "cpp": "http://localhost:3000/venus-quackster-harness",
}


def capture(name: str, url: str) -> None:
    opts = Options()
    opts.headless = True
    driver = webdriver.Firefox(options=opts)
    try:
        driver.set_window_size(1024, 768)
        driver.get(url)
        wait = WebDriverWait(driver, 60)
        wait.until(EC.presence_of_element_located((By.TAG_NAME, "canvas")))
        # Let Habbo settle into the Hotel Navigator view.
        time.sleep(5.0)
        path = OUT_DIR / f"{name}.png"
        driver.save_screenshot(str(path))
        print(f"saved {path}")
    finally:
        driver.quit()


def main() -> int:
    for name, url in URLS.items():
        capture(name, url)
    return 0


if __name__ == "__main__":
    sys.exit(main())
