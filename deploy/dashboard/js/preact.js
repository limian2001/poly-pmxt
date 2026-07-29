// CDN 依赖收敛到这一个文件。
// 其他模块一律 `import { html, useState } from './preact.js'`，不要各自去写 esm.sh 的地址 ——
// 万一哪天要换 CDN、或者改成把 preact 打包进镜像离线用，只改这里一处。
import { h, render, Fragment, createRef } from 'https://esm.sh/preact@10.24.3';
import { useState, useEffect, useRef, useMemo, useCallback, useLayoutEffect } from 'https://esm.sh/preact@10.24.3/hooks';
import { memo } from 'https://esm.sh/preact@10.24.3/compat';
import htmModule from 'https://esm.sh/htm@3.1.1';

export const html = htmModule.bind(h);
export { h, render, Fragment, createRef, memo };
export { useState, useEffect, useRef, useMemo, useCallback, useLayoutEffect };
