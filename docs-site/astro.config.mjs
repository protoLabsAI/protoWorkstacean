// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

const base = process.env.BASE_PATH ?? '/protoWorkstacean';

export default defineConfig({
  base,
  outDir: './out',
  integrations: [
    starlight({
      title: 'protoWorkstacean',
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/protoLabsAI/protoWorkstacean',
        },
      ],
      sidebar: [
        {
          label: 'Tutorials',
          autogenerate: { directory: 'tutorials' },
        },
        {
          label: 'Guides',
          autogenerate: { directory: 'guides' },
        },
        {
          label: 'Reference',
          autogenerate: { directory: 'reference' },
        },
        {
          label: 'Explanation',
          autogenerate: { directory: 'explanation' },
        },
        {
          label: 'Contributing',
          autogenerate: { directory: 'contributing' },
        },
      ],
    }),
  ],
});
