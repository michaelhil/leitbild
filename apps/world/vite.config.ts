import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vite'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const packageJson = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  readonly version: string
}

export default defineConfig({
  root: 'src/ui',
  plugins: [svelte()],
  define: {
    __LEITBILD_VERSION__: JSON.stringify(packageJson.version),
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets/world',
    emptyOutDir: true,
    rollupOptions: {
      // The embed page is a separate, light entry for views shown inside
      // other Modules; it must not pull in the map application.
      input: {
        main: fileURLToPath(new URL('./src/ui/index.html', import.meta.url)),
        embed: fileURLToPath(new URL('./src/ui/embed.html', import.meta.url)),
      },
      output: {
        manualChunks: (id: string): string | undefined => {
          if (id.includes('/node_modules/maplibre-gl/')) return 'maplibre'
          if (id.includes('/node_modules/svelte/')) return 'svelte'
          return undefined
        },
      },
    },
  },
})
