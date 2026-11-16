# 三维模型发布

`npm ci` 后运行 `npm run build:model`，从 `dist/assets/model/second-floor.json` 导出 GLB。

- 13 个材质网格，保留原三角面、顶点、法线和 UV；使用与原网页 GPU 缓冲区相同的 Float32 精度。
- EXT_meshopt_compression 采用无损编码，不执行简化或删面。
- 输出带内容哈希的 `.glb` 和 `.glb.gz`，并自动更新 `dist/model-asset.js`。
- 支持原生解压的浏览器下载 gzip 版本；其他浏览器下载 GLB。均在本地解码，不依赖外部 CDN。
- 版本文件使用一年 immutable 缓存；模型变化会生成新文件名。
- 材质纹理继续在模型首次显示后异步加载。

验证：`node --test tests/spatial-model.test.mjs tests/spatial-loading.test.mjs`。
测试逐元素比较转换前后的顶点属性，并检查每个三角面的有向顶点顺序。
