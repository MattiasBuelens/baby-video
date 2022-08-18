import {resolve} from 'path';
import {defineConfig} from 'vite';

export default defineConfig({
    // https://vitejs.dev/guide/build.html#library-mode
    build: {
        lib: {
            entry: resolve(__dirname, './src/baby-video.ts'),
            name: 'BabyVideo',
            fileName: 'baby-video'
        }
    }
})
