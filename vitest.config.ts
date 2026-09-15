import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Compiled output from `npm run build` must never be collected as tests.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/cypress/**",
      "**/.{idea,git,cache,output,temp}/**",
      "**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build}.config.*",
    ],
  },
});
