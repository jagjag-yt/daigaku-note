// js/webdav.js を「端末ごとに別のもの」として読み込むための仕掛け(node:module の register で使う)。
// js/webdav.js?dev=A が読み込む ./db.js を、test/fake-db.mjs?dev=A(端末 A だけの中身)に差し替える。
export async function resolve(specifier, context, next) {
  const m = /\/js\/webdav\.js\?(.*)$/.exec(context.parentURL || '');
  if (m && specifier === './db.js') return { url: new URL(`../test/fake-db.mjs?${m[1]}`, context.parentURL).href, shortCircuit: true };
  return next(specifier, context);
}
