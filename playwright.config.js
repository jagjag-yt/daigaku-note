// 画面の崩れを見つけるテスト(npm run test:ui)。
// iPhone・Android・iPad・PC の大きさで、Chromium(Chrome・Android と同じ仕組み)と
// WebKit(Safari・iPad と同じ仕組み)の両方を開き、
//   1) 決まりごと(はみ出し・重なり・押しにくいボタンがないか)を確かめる
//   2) スクショを撮って、基準の画像と比べる(test/ui/__screenshots__/)
// 基準の画像は文字の描かれ方が環境で変わるので、GitHub Actions(.github/workflows/ui.yml)で作る。
import { defineConfig } from '@playwright/test';

const SIZES = {
  'phone': { viewport: { width: 390, height: 844 }, hasTouch: true },
  'phone-small': { viewport: { width: 360, height: 640 }, hasTouch: true },
  'phone-land': { viewport: { width: 844, height: 390 }, hasTouch: true },
  'ipad': { viewport: { width: 820, height: 1180 }, hasTouch: true },
  'ipad-land': { viewport: { width: 1180, height: 820 }, hasTouch: true },
  'pc': { viewport: { width: 1440, height: 900 }, hasTouch: false },
};
const ENGINES = ['chromium', 'webkit'];

export default defineConfig({
  testDir: 'test/ui',
  snapshotPathTemplate: '{testDir}/__screenshots__/{projectName}/{arg}{ext}',
  fullyParallel: true,
  workers: process.env.CI ? 2 : undefined,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  expect: {
    toHaveScreenshot: { maxDiffPixelRatio: 0.002, threshold: 0.2, animations: 'disabled', caret: 'hide', scale: 'css' },
  },
  use: {
    baseURL: 'http://localhost:8130/',
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    colorScheme: 'light',
    serviceWorkers: 'block',
  },
  webServer: {
    command: 'node serve.mjs 8130',
    url: 'http://localhost:8130/',
    reuseExistingServer: !process.env.CI,
  },
  projects: ENGINES.flatMap((browserName) => Object.entries(SIZES).map(([size, opts]) => ({
    name: `${browserName}-${size}`,
    use: { browserName, ...opts, deviceScaleFactor: 1 },
  }))),
});
