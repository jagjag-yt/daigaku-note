// 画面の色(ライト・ダーク)を、描き始める前に決める(app.js を読むまで待つと、一瞬白く光るため)。
// 値は設定画面で選んだもの。localStorage が使えないときは端末の設定に合わせる
(function () {
  try {
    var t = localStorage.getItem('daigaku-note-theme');
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  } catch (e) { /* 使えないときは端末に合わせる */ }
})();
