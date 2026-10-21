/// <reference types="vite/client" />

// vite/client 提供 import.meta.env 的类型（BASE_URL 等）。
// 这里不显式列 tsconfig 的 types，让 TypeScript 自动发现 node_modules/@types/*。
export {}
