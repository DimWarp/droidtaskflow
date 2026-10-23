import { defineConfig } from 'vite';

// 给 /fonts/ 路径的静态资源设 1 年 immutable 缓存。
//
// 背景：self-hosted 字体（MapleMono SC NF）woff2 单文件 6-7 MB，
// vite dev / preview 默认 cache-control: no-store，硬刷 / 重启 dev server
// 会重下整个字体包，体验非常差。
//
// 生产部署侧需要在静态托管（nginx / vercel / netlify）里
// 同样给 /fonts/ 加 immutable header；这里只覆盖 dev + preview。

function setFontsCacheHeader(server) {
  server.middlewares.use((req, res, next) => {
    if (req.url && req.url.startsWith('/fonts/')) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
    next();
  });
}

const staticFontCachePlugin = () => ({
  name: 'dtf-font-immutable-cache',
  apply: 'serve',
  configureServer: setFontsCacheHeader,
  configurePreviewServer: setFontsCacheHeader,
});

export default defineConfig({
  // GitHub Pages 部署在 https://dimwarp.github.io/droidtaskflow/ 子路径下。
  // base 必须与之匹配，否则构建产物里的 /assets/... 会解析到域名根目录而 404
  // （表现为：页面出来但样式全丢）。dev server 下 base 同样生效，无副作用。
  base: '/droidtaskflow/',
  plugins: [staticFontCachePlugin()],
});
