// Launch Chromium for the scripts in this folder. In CI the runner's Chrome is
// used (`channel: "chrome"`); locally set CHROME_PATH to a Chromium binary, or
// have a Playwright browser installed.
import { chromium, devices } from "playwright-core";

export { devices };

export async function launch() {
  const executablePath = process.env.CHROME_PATH || undefined;
  const channel = executablePath
    ? undefined
    : process.env.CHROME_CHANNEL || "chrome";
  return chromium.launch({ executablePath, channel });
}
